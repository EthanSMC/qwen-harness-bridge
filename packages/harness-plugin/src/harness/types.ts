import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentSetup,
} from "@deepseek-ai/dsh-agent";
import type {
  Session,
  SessionEvent,
  SessionId,
} from "@deepseek-ai/dsh-session";
import type { LocalJobMapping } from "../store/plugin-store.js";

export type NormalizedHarnessEvent = Readonly<{
  jobId: string;
  type:
    | "stage.changed"
    | "progress.updated"
    | "tool.started"
    | "tool.finished"
    | "job.succeeded"
    | "job.failed";
  stage: string;
  summary: string;
  occurredAt: string;
}>;

export interface HarnessAgentAdapter {
  create(input: {
    jobId: string;
    repositoryPath: string;
    request: string;
  }): Promise<{ sessionId: string }>;
  resume(input: { jobId: string; sessionId: string }): Promise<void>;
  cancel(jobId: string): Promise<"requested" | "already_idle" | "unknown">;
  dispose(): Promise<void>;
}

export interface HarnessAgentRegistry {
  create(options: {
    readonly sessionId: SessionId;
    readonly meta?: { readonly cwd?: string };
    readonly agentOptions?: AgentOptions;
    readonly setup?: AgentSetup;
  }): Promise<AgentHandle>;
  resume(options: {
    readonly resumeSessionId: SessionId;
    readonly agentOptions?: AgentOptions;
    readonly setup?: AgentSetup;
  }): Promise<AgentHandle>;
}

export interface HarnessContext {
  agents: HarnessAgentRegistry;
  on(
    name: "session/event",
    listener: (session: Session, event: SessionEvent) => void,
  ): () => unknown;
}

export type OwnedSession = Readonly<{
  jobId: string;
  attempt: number;
  sessionId: string;
}>;

export interface HarnessMappingStore {
  mapJob(input: {
    jobId: string;
    attempt: number;
    sessionId: string;
    status: string;
  }): void;
  findJob(jobId: string): LocalJobMapping | undefined;
  listNonterminalJobs(): readonly LocalJobMapping[];
}

export type HarnessSessionEventHandler = (
  owner: OwnedSession,
  session: Session,
  event: SessionEvent,
) => void;

export type HarnessAdapterOptions = Readonly<{
  ctx: HarnessContext;
  store: HarnessMappingStore;
  agentOptions?: AgentOptions;
  setup?: AgentSetup;
  onEvent?: (event: NormalizedHarnessEvent) => void | Promise<void>;
  recoverMappings?:
    | readonly LocalJobMapping[]
    | (() => readonly LocalJobMapping[] | Promise<readonly LocalJobMapping[]>);
}>;

export type HarnessAgent = Agent;
