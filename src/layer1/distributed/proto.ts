import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Phase 14.0: shared between coordinator.ts and solver-node.ts - both
// already depend on @grpc/grpc-js and @grpc/proto-loader directly (they
// ARE the point of both files), so sharing this loader creates no
// meaningful "avoid a heavy import" concern the way sandbox-runner-worker.ts
// duplicating a tiny parser to dodge a z3-solver transitive import did
// (Phase 12.1) - the two situations aren't the same, and treating them
// identically would be copying a rule past its reason.

const dirname = path.dirname(fileURLToPath(import.meta.url))
const PROTO_PATH = path.join(dirname, 'solver-grid.proto')

export interface NodeCapabilitiesMessage {
  nodeId: string
}
export interface TaskLeaseMessage {
  leaseId: string
  taskJson: string
  executionMode: string
}
export interface TaskResultMessage {
  leaseId: string
  ok: boolean
  gatesJson: string
  error: string
}
export interface NodeStatusMessage {
  nodeId: string
  leaseId: string
}
export interface AckMessage {
  ok: boolean
}

export interface SolverGridClient extends grpc.Client {
  leaseTask(request: NodeCapabilitiesMessage): grpc.ClientReadableStream<TaskLeaseMessage>
  reportResult(request: TaskResultMessage, callback: (error: grpc.ServiceError | null, response: AckMessage) => void): void
  heartbeat(request: NodeStatusMessage, callback: (error: grpc.ServiceError | null, response: AckMessage) => void): void
}

interface SolverGridClientConstructor {
  new (address: string, credentials: grpc.ChannelCredentials): SolverGridClient
}

// GrpcObject's recursive index type (GrpcObject | ServiceClientConstructor
// | ProtobufTypeDefinition) can't be narrowed to a specific service's real
// shape automatically - this single, documented assertion is the one place
// that bridges @grpc/proto-loader's dynamic (codegen-free) loading to the
// concrete types this file's callers actually use.
function loadSolverGrid(): { service: grpc.ServiceDefinition; Client: SolverGridClientConstructor } {
  const packageDef = protoLoader.loadSync(PROTO_PATH, { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true })
  const loaded = grpc.loadPackageDefinition(packageDef) as unknown as { solvergrid: { SolverGrid: grpc.ServiceClientConstructor } }
  return { service: loaded.solvergrid.SolverGrid.service, Client: loaded.solvergrid.SolverGrid as unknown as SolverGridClientConstructor }
}

export function loadSolverGridServiceDefinition(): grpc.ServiceDefinition {
  return loadSolverGrid().service
}

export function createSolverGridClient(address: string): SolverGridClient {
  const { Client } = loadSolverGrid()
  return new Client(address, grpc.credentials.createInsecure())
}
