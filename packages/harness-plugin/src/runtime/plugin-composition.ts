import type { ConnectorServerMessage } from "@qhb/protocol";

export type PluginCompositionDependencies = Readonly<{
  coordinator: Readonly<{
    handle(command: ConnectorServerMessage): Promise<void>;
  }>;
  connector: Readonly<{
    onCommand(
      handler: (command: ConnectorServerMessage) => Promise<void>,
    ): () => void;
    start(signal: AbortSignal): Promise<void>;
  }>;
  approvals: Readonly<{ dispose(): void }>;
  driver: Readonly<{ dispose(): Promise<void> }>;
  store: Readonly<{ close(): void }>;
  /** Local, contained teardown diagnosis. Never uploaded and never thrown. */
  report?: (error: unknown, stage: string) => void;
}>;

/** Cordis-owned plugin lifecycle. Listeners are registered before the
 * transport connects and teardown follows the fixed order: stop intake, abort
 * pending approvals, cancel/await owned Agents, stop the transport (flush and
 * close the socket), then close SQLite. Every stage is contained so one failure
 * cannot leak a later resource. */
export class PluginComposition {
  readonly #dependencies: PluginCompositionDependencies;
  readonly #intake = new AbortController();
  readonly #lifetime = new AbortController();
  #unregister: (() => void) | undefined;
  #transport: Promise<void> | undefined;
  #disposed = false;

  constructor(dependencies: PluginCompositionDependencies) {
    this.#dependencies = dependencies;
  }

  connect(): void {
    if (this.#disposed || this.#unregister !== undefined) return;
    const unregister = this.#dependencies.connector.onCommand(
      async (command) => {
        if (this.#intake.signal.aborted) return;
        await this.#dependencies.coordinator.handle(command);
      },
    );
    this.#unregister = () => {
      unregister();
    };
    this.#transport = Promise.resolve(
      this.#dependencies.connector.start(this.#lifetime.signal),
    ).catch((error: unknown) => {
      this.#report(error, "transport");
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#intake.abort();
    this.#run("intake", () => {
      const unregister = this.#unregister;
      this.#unregister = undefined;
      unregister?.();
    });
    this.#run("approvals", () => this.#dependencies.approvals.dispose());
    try {
      await this.#dependencies.driver.dispose();
    } catch (error) {
      this.#report(error, "driver");
    }
    this.#lifetime.abort();
    try {
      await this.#transport;
    } catch (error) {
      this.#report(error, "transport");
    }
    this.#run("store", () => this.#dependencies.store.close());
  }

  #run(stage: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.#report(error, stage);
    }
  }

  #report(error: unknown, stage: string): void {
    try {
      this.#dependencies.report?.(error, stage);
    } catch {
      // Diagnosis cannot interrupt containment.
    }
  }
}

export const createPluginComposition = (
  dependencies: PluginCompositionDependencies,
): PluginComposition => new PluginComposition(dependencies);
