// Story 071 — ACP SDK 2.x removed `ClientSideConnection` and the `Client` interface. The wire
// tests drive the BUILT adapter as Zed does, through a client connection; this helper rebuilds the
// slice of the 1.x surface they use on the 2.x `client()` builder, so the tests read as before and
// the adapter under test sees the same requests and notifications. The client handlers mirror ACP
// 1.8.0's own legacy adapter (`legacyClientApp`, dist/acp.js), `writeTextFile`'s `?? {}` included.

import { client, methods, type Stream } from "@agentclientprotocol/sdk/unstable";
import type {
  CancelNotification,
  CloseSessionRequest,
  CreateElicitationRequest,
  CreateElicitationResponse,
  DeleteSessionRequest,
  ForkSessionRequest,
  InitializeRequest,
  ListSessionsRequest,
  LoadSessionRequest,
  LogoutRequest,
  NewSessionRequest,
  PromptRequest,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionModeRequest,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk/unstable";

/** What the test plays as the client: ACP 1.x's `Client` callbacks this fork's tests implement. */
export interface TestClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse | void>;
  createElicitation?(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
}

/** Connect `testClient` over `stream` and return the agent-side calls the tests make, named as
 *  ACP 1.x's `ClientSideConnection` named them. */
export function connectTestClient(testClient: TestClient, stream: Stream) {
  let app = client()
    .onNotification(methods.client.session.update, (ctx) => testClient.sessionUpdate(ctx.params))
    .onRequest(methods.client.session.requestPermission, (ctx) =>
      testClient.requestPermission(ctx.params),
    )
    .onRequest(methods.client.fs.readTextFile, (ctx) => testClient.readTextFile(ctx.params))
    .onRequest(
      methods.client.fs.writeTextFile,
      async (ctx) => (await testClient.writeTextFile(ctx.params)) ?? {},
    );
  if (testClient.createElicitation) {
    const createElicitation = testClient.createElicitation.bind(testClient);
    app = app.onRequest(methods.client.elicitation.create, (ctx) => createElicitation(ctx.params));
  }
  const connection = app.connect(stream);
  const agent = connection.agent;
  return {
    signal: connection.signal,
    closed: connection.closed,
    initialize: (params: InitializeRequest) => agent.request(methods.agent.initialize, params),
    newSession: (params: NewSessionRequest) => agent.request(methods.agent.session.new, params),
    loadSession: (params: LoadSessionRequest) => agent.request(methods.agent.session.load, params),
    listSessions: (params: ListSessionsRequest) =>
      agent.request(methods.agent.session.list, params),
    resumeSession: (params: ResumeSessionRequest) =>
      agent.request(methods.agent.session.resume, params),
    unstable_forkSession: (params: ForkSessionRequest) =>
      agent.request(methods.agent.session.fork, params),
    closeSession: (params: CloseSessionRequest) =>
      agent.request(methods.agent.session.close, params),
    deleteSession: (params: DeleteSessionRequest) =>
      agent.request(methods.agent.session.delete, params),
    setSessionMode: (params: SetSessionModeRequest) =>
      agent.request(methods.agent.session.setMode, params),
    setSessionConfigOption: (params: SetSessionConfigOptionRequest) =>
      agent.request(methods.agent.session.setConfigOption, params),
    prompt: (params: PromptRequest) => agent.request(methods.agent.session.prompt, params),
    cancel: (params: CancelNotification) => agent.notify(methods.agent.session.cancel, params),
    logout: (params: LogoutRequest) => agent.request(methods.agent.logout, params),
  };
}

export type TestClientConnection = ReturnType<typeof connectTestClient>;
