import { Ros, Service, Topic, type ITransportFactory } from 'roslib';

export interface RosStatus {
  connected: boolean;
  url: string;
  error: string | null;
}

export interface TopicInfo {
  name: string;
  type: string;
}

interface SubscriptionEntry {
  topic: string;
  type: string;
  onMessage: (msg: unknown) => void;
  handle?: Topic;
}

export interface ActivePublisher {
  topic: string;
  type: string;
  frequency: number;
  duration: number | null;
  startedAt: number;
  endsAt: number | null;
}

interface PublishTimer extends ActivePublisher {
  interval: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
}

export class RosDisconnectedError extends Error {
  constructor(message = 'Not connected to rosbridge') {
    super(message);
    this.name = 'RosDisconnectedError';
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return 'WebSocket connection error';
}

export function validateRosbridgeUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('Rosbridge URL must use ws:// or wss://');
  }
  return raw;
}

export class RosBridge {
  private url: string;
  private lastError: string | null = null;
  private ros!: Ros;
  private publishers = new Map<string, Topic>();
  private publishTimers = new Map<string, PublishTimer>();
  private subscriptions = new Set<SubscriptionEntry>();
  private statusListeners = new Set<(status: RosStatus) => void>();
  private publisherListeners = new Set<(publishers: ActivePublisher[]) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly transportFactory?: ITransportFactory;

  constructor(
    url = process.env.ROSBRIDGE_URL ?? 'ws://localhost:9090',
    transportFactory?: ITransportFactory,
  ) {
    this.url = validateRosbridgeUrl(url);
    this.transportFactory = transportFactory;
    this.connect(this.url);
  }

  getStatus(): RosStatus {
    return {
      connected: this.ros?.isConnected ?? false,
      url: this.url,
      error: this.lastError,
    };
  }

  onStatusChange(listener: (status: RosStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  getActivePublishers(): ActivePublisher[] {
    return Array.from(this.publishTimers.values(), ({ topic, type, frequency, duration, startedAt, endsAt }) => ({
      topic,
      type,
      frequency,
      duration,
      startedAt,
      endsAt,
    }));
  }

  onPublishersChange(listener: (publishers: ActivePublisher[]) => void): () => void {
    this.publisherListeners.add(listener);
    return () => this.publisherListeners.delete(listener);
  }

  connect(nextUrl?: string): RosStatus {
    if (nextUrl !== undefined) {
      this.url = validateRosbridgeUrl(nextUrl);
    }
    this.closed = false;
    this.clearReconnect();
    this.teardownRos();

    const ros = new Ros({ transportFactory: this.transportFactory });
    this.ros = ros;

    ros.on('connection', () => {
      if (this.ros !== ros) return;
      this.lastError = null;
      this.attachSubscriptions(ros);
      this.emitStatus();
    });

    ros.on('close', () => {
      if (this.ros !== ros) return;
      this.stopPublish();
      this.publishers.clear();
      this.emitStatus();
      if (!this.closed) this.scheduleReconnect(ros);
    });

    ros.on('error', (err) => {
      if (this.ros !== ros) return;
      this.lastError = formatError(err);
      this.emitStatus();
    });

    ros.connect(this.url).catch((err) => {
      if (this.ros !== ros) return;
      this.lastError = formatError(err);
      this.emitStatus();
      if (!this.closed) this.scheduleReconnect(ros);
    });

    return this.getStatus();
  }

  publish(
    topic: string,
    type: string,
    payload: Record<string, unknown>,
    options?: { frequency?: number; duration?: number },
  ): void {
    this.requireConnected();
    const hadTimer = this.removeTimer(topic);

    const existing = this.publishers.get(topic);
    if (existing && existing.messageType !== type) {
      existing.unadvertise();
      this.publishers.delete(topic);
    }
    let pub = this.publishers.get(topic);
    if (!pub) {
      pub = new Topic({ ros: this.ros, name: topic, messageType: type });
      this.publishers.set(topic, pub);
    }
    pub.publish(payload);

    const frequency = options?.frequency ?? 0;
    const duration = options?.duration ?? 0;
    if (!Number.isFinite(frequency) || frequency <= 0) {
      if (hadTimer) this.emitPublishers();
      return;
    }

    const intervalMs = Math.max(1, 1000 / frequency);
    const validDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const startedAt = Date.now();
    const endsAt = validDuration > 0 ? startedAt + validDuration * 1000 : null;
    const ros = this.ros;

    // ponytail: setInterval has a 1ms floor and minor drift under load; upgrade to an hrtime loop if strict deterministic ROS rate timing is needed.
    const entry: PublishTimer = {
      topic,
      type,
      frequency,
      duration: validDuration > 0 ? validDuration : null,
      startedAt,
      endsAt,
      interval: setInterval(() => {
        if (
          this.ros !== ros ||
          !ros.isConnected ||
          this.publishTimers.get(topic) !== entry ||
          (endsAt !== null && Date.now() >= endsAt)
        ) {
          this.stopPublish(topic);
          return;
        }
        pub.publish(payload);
      }, intervalMs),
    };

    if (validDuration > 0) {
      entry.timeout = setTimeout(() => {
        if (this.publishTimers.get(topic) === entry) {
          this.stopPublish(topic);
        }
      }, validDuration * 1000);
    }

    this.publishTimers.set(topic, entry);
    this.emitPublishers();
  }

  subscribe(topic: string, type: string, onMessage: (msg: unknown) => void): () => void {
    const entry: SubscriptionEntry = { topic, type, onMessage };
    this.subscriptions.add(entry);
    if (this.ros.isConnected) {
      this.attachEntry(this.ros, entry);
    }
    return () => {
      this.subscriptions.delete(entry);
      entry.handle?.unsubscribe(onMessage);
      entry.handle = undefined;
    };
  }

  getTopics(timeoutMs = 5000): Promise<TopicInfo[]> {
    this.requireConnected();
    return this.withTimeout(timeoutMs, (resolve, reject) => {
      this.ros.getTopics(
        (res) => resolve(res.topics.map((name, i) => ({ name, type: res.types[i] ?? '' }))),
        (err) => reject(new Error(err)),
      );
    });
  }

  getServices(timeoutMs = 5000): Promise<string[]> {
    this.requireConnected();
    return this.withTimeout(timeoutMs, (resolve, reject) => {
      this.ros.getServices(resolve, (err) => reject(new Error(err)));
    });
  }

  callService(
    service: string,
    type: string,
    request: Record<string, unknown> = {},
    timeoutSec = 10,
  ): Promise<unknown> {
    this.requireConnected();
    const client = new Service({ ros: this.ros, name: service, serviceType: type });
    return this.withTimeout(timeoutSec * 1000 + 1000, (resolve, reject) => {
      client.callService(
        request,
        resolve,
        (err) => reject(new Error(err)),
        timeoutSec,
      );
    });
  }

  stopPublish(topic?: string): string[] {
    if (topic === undefined) {
      const stopped = [...this.publishTimers.keys()];
      for (const name of stopped) this.removeTimer(name);
      if (stopped.length > 0) this.emitPublishers();
      return stopped;
    }
    if (!this.removeTimer(topic)) return [];
    this.emitPublishers();
    return [topic];
  }

  close(): void {
    this.closed = true;
    this.clearReconnect();
    this.teardownRos();
    this.subscriptions.clear();
  }

  private requireConnected(): void {
    if (!this.ros?.isConnected) {
      throw new RosDisconnectedError();
    }
  }

  private withTimeout<T>(
    ms: number,
    executor: (resolve: (value: T) => void, reject: (reason: Error) => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ROS request timed out')), ms);
      executor(
        (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private attachSubscriptions(ros: Ros): void {
    for (const entry of this.subscriptions) {
      this.attachEntry(ros, entry);
    }
  }

  private attachEntry(ros: Ros, entry: SubscriptionEntry): void {
    const t = new Topic({ ros, name: entry.topic, messageType: entry.type });
    entry.handle = t;
    t.subscribe(entry.onMessage);
  }

  private teardownRos(): void {
    this.stopPublish();
    for (const entry of this.subscriptions) {
      entry.handle?.unsubscribe(entry.onMessage);
      entry.handle = undefined;
    }
    for (const pub of this.publishers.values()) {
      if (this.ros?.isConnected) pub.unadvertise();
    }
    this.publishers.clear();
    this.ros?.close();
  }

  private scheduleReconnect(ros: Ros): void {
    this.clearReconnect();
    // ponytail: fixed 3s reconnect interval; add exponential backoff if rosbridge churns.
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed && this.ros === ros && !ros.isConnected) {
        this.connect();
      }
    }, 3000);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private removeTimer(topic: string): boolean {
    const entry = this.publishTimers.get(topic);
    if (!entry) return false;
    clearInterval(entry.interval);
    if (entry.timeout) clearTimeout(entry.timeout);
    this.publishTimers.delete(topic);
    return true;
  }

  private emitStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private emitPublishers(): void {
    const publishers = this.getActivePublishers();
    for (const listener of this.publisherListeners) {
      listener(publishers);
    }
  }
}
