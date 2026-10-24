/**
 * Same-session goal domain: event-sourced state, compare-and-set mutations,
 * and process-local continuation activation.
 * @module @deepseek-ai/dsh-goal
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  applyGoalEvent,
  goalChangeRef,
  MAX_GOAL_SUBGOALS,
} from './fold.ts'
import type { GoalFoldState } from './fold.ts'
import {
  GOAL_CHANGE_VERSION,
  GoalError,
  GoalId,
} from './runtime.ts'
import type {
  AddGoalSubgoalRequest,
  CreateGoalRequest,
  CreateGoalResult,
  EditGoalRequest,
  GoalActivation,
  GoalBlockReason,
  GoalPhase,
  GoalProjection,
  GoalProjectionState,
  GoalRef,
  GoalSnapshot,
  GoalSubgoal,
  GoalView,
  RemoveGoalSubgoalRequest,
  UpdateGoalSubgoalRequest,
} from './types.ts'
import type {
  GoalChangeMeta,
  GoalChanged,
  GoalClearChangeMeta,
  GoalOperation,
  GoalSnapshotChangeMeta,
  GoalSubgoalChangeMeta,
  GoalSubgoalOperation,
} from './domain.ts'

export type * from './types.ts'
export type * from './domain.ts'
export { GOAL_CHANGE_VERSION, GoalError, GoalId } from './runtime.ts'
export { decodeGoalChange, decodeGoalSubgoalChange, foldGoal, goalChangeRef } from './fold.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    goals: GoalService
  }
}

/** Wire schema of one subgoal row inside the `goal` projection. */
const goalSubgoalSchema = zod.object({
  id: zod.string().min(1),
  title: zod.string().min(1),
  status: zod.union([zod.literal('open'), zod.literal('done'), zod.literal('blocked')]),
  note: zod.string().min(1).optional(),
})

/** Wire payload schema of the `goal` projection (current goal or pre-create/cleared null). */
const goalProjectionSchema: ZodType<GoalProjection | null> = zod.union([
  zod.object({
    goal: zod.object({
      id: zod.string().min(1),
      revision: zod.number().int().positive(),
      objective: zod.string().min(1),
      phase: zod.union([zod.literal('active'), zod.literal('paused'), zod.literal('blocked'), zod.literal('complete')]),
      blockedReason: zod.object({ code: zod.string(), message: zod.string() }).optional(),
      maxGoalRounds: zod.number().int().positive(),
    }),
    roundsStarted: zod.number().int().nonnegative(),
    createdAt: zod.number(),
    updatedAt: zod.number(),
    subgoals: zod.array(goalSubgoalSchema),
  }),
  zod.null(),
]) as ZodType<GoalProjection | null>

const goalProjectionStateSchema: ZodType<GoalProjectionState> = zod.object({
  current: goalProjectionSchema,
  seenGoalIds: zod.array(zod.string().min(1)).refine(
    ids => new Set(ids).size === ids.length,
    { message: 'seen goal ids must be unique' },
  ),
  failure: zod.string().min(1).nullable(),
}).strict().superRefine((state, context) => {
  if (state.current === null) return
  if (!state.seenGoalIds.includes(state.current.goal.id)) {
    context.addIssue({ code: 'custom', message: 'current goal id must be retained among seen goal ids' })
  }
  if (state.current.updatedAt < state.current.createdAt) {
    context.addIssue({ code: 'custom', message: 'current goal update cannot precede its creation' })
  }
  if (state.current.roundsStarted > state.current.goal.maxGoalRounds) {
    context.addIssue({ code: 'custom', message: 'current goal rounds cannot exceed its configured limit' })
  }
}) as unknown as ZodType<GoalProjectionState>

/** Build strict fold state from one checkpoint-safe projection state. */
function goalFoldState(state: GoalProjectionState): GoalFoldState {
  return {
    goal: state.current?.goal,
    roundsStarted: state.current?.roundsStarted ?? 0,
    createdAt: state.current?.createdAt,
    updatedAt: state.current?.updatedAt,
    lastRef: undefined,
    seenGoalIds: new Set(state.seenGoalIds),
    subgoals: state.current === null ? [] : [...state.current.subgoals],
  }
}

/** Convert strict fold state into checkpoint-safe projection state. */
function goalProjectionState(state: GoalFoldState): GoalProjectionState {
  let current: GoalProjection | null = null
  if (state.goal !== undefined) {
    const { createdAt, updatedAt } = state
    if (createdAt === undefined || updatedAt === undefined) {
      throw new Error('current goal fold lacks timestamps')
    }
    current = {
      goal: state.goal,
      roundsStarted: state.roundsStarted,
      createdAt,
      updatedAt,
      subgoals: state.subgoals.map(subgoal => ({ ...subgoal })),
    }
  }
  return {
    current,
    seenGoalIds: [...state.seenGoalIds],
    failure: null,
  }
}

/**
 * Fold durable goal events through the strict replay rules without throwing
 * from the projection registry's event drive. The first invalid owned event
 * is retained in `failure`; host goal access rejects that state while the
 * client view remains at the last valid goal.
 * @param state - the projection covering all prior events.
 * @param event - the next committed session event.
 * @returns the next projection (same reference when the event is unrelated).
 */
export function applyGoalProjection(state: GoalProjectionState, event: SessionEvent): GoalProjectionState {
  if (state.failure !== null) return state
  if (event.type !== 'goal/change' && event.type !== 'goal/subgoal'
    && (event.type !== 'user/message' || event.data.source.kind !== 'goal')) return state
  const folded = goalFoldState(state)
  try {
    applyGoalEvent(folded, event)
    return goalProjectionState(folded)
  } catch (error: unknown) {
    /* v8 ignore next -- the strict goal fold throws Error instances. */
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, failure: `goal replay failed at session event ${event.seq}: ${message}` }
  }
}

/** Strict host goal state with the existing cropped client value. */
export const goalProjectionDefinition = {
  key: 'goal',
  stateSchema: goalProjectionStateSchema,
  init: (): GoalProjectionState => ({ current: null, seenGoalIds: [], failure: null }),
  apply: applyGoalProjection,
  wire: { viewSchema: goalProjectionSchema, view: state => state.current },
  stateVersion: 7,
} satisfies ProjectionDefinition<'goal', GoalProjectionState>

/** Deployment defaults for goal creation. */
export interface Config {
  /** Total rounds used when a create request omits its own cap. */
  defaultMaxGoalRounds?: number
}

/** Resolved defaults. */
export interface ResolvedConfig {
  /** Validated positive safe-integer default round cap. */
  defaultMaxGoalRounds: number
}

/** Process-local activation state crossing the synchronous append boundary. */
interface GoalRuntimeState {
  activation: GoalActivation
  pendingActivation: {
    readonly offset: SessionLogOffset
    readonly activation: GoalActivation
  } | undefined
}

/** Validated create input with every deployment default materialized. */
interface ResolvedCreateGoal {
  readonly objective: string
  readonly maxGoalRounds: number
}

/** Validate a caller-visible positive safe-integer round cap. */
function resolveMaxGoalRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError('maxGoalRounds must be a positive safe integer', 'GOAL_INVALID_MAX_ROUNDS')
  }
  return value
}

/** Validate and normalize an objective at the domain boundary. */
function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal objective must be a non-empty string', 'GOAL_INVALID_OBJECTIVE')
  }
  return value.trim()
}

/** Materialize deployment defaults and validate one create request. */
function resolveCreateGoal(request: CreateGoalRequest, defaultMaxGoalRounds: number): ResolvedCreateGoal {
  return {
    objective: resolveObjective(request.objective),
    maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds ?? defaultMaxGoalRounds),
  }
}

/** Validate and normalize a subgoal title at the domain boundary. */
function resolveSubgoalTitle(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal subgoal title must be a non-empty string', 'GOAL_INVALID_SUBGOAL')
  }
  const title = value.trim()
  if (title.length > 160) {
    throw new GoalError('goal subgoal title cannot exceed 160 characters', 'GOAL_INVALID_SUBGOAL')
  }
  return title
}

/** Validate one replacement note; `null` clears it, `undefined` leaves it unchanged. */
function resolveSubgoalNote(value: string | null): string | undefined {
  if (value === null) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal subgoal note must be a non-empty string or null', 'GOAL_INVALID_SUBGOAL')
  }
  const note = value.trim()
  if (note.length > 500) {
    throw new GoalError('goal subgoal note cannot exceed 500 characters', 'GOAL_INVALID_SUBGOAL')
  }
  return note
}

/** Mint the next service-owned subgoal id for one existing list. */
function nextSubgoalId(subgoals: readonly GoalSubgoal[]): string {
  let highest = 0
  for (const subgoal of subgoals) {
    const match = /^s([1-9][0-9]*)$/.exec(subgoal.id)
    /* v8 ignore next -- the fold rejects any id that is not s<N>, so the regex always matches. */
    if (match === null) continue
    highest = Math.max(highest, Number(match[1]))
  }
  return `s${String(highest + 1)}`
}

/** Validate and detach one policy-owned blocker explanation. */
function resolveBlockReason(reason: unknown): GoalBlockReason {
  const record = typeof reason === 'object' && reason !== null && !Array.isArray(reason)
    ? reason as Record<string, unknown>
    : undefined
  const code = record?.['code']
  const message = record?.['message']
  if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)
    || typeof message !== 'string' || message.trim().length === 0) {
    throw new GoalError(
      'goal block reason requires a lower-kebab-case code and a non-empty message',
      'GOAL_INVALID_BLOCK_REASON',
    )
  }
  return { code, message: message.trim() }
}

/** Goal service (`ctx.goals`) backed exclusively by the owning session log. */
export class GoalService extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections']

  static Config: z<Config> = z.object({
    defaultMaxGoalRounds: z.number().default(256),
  })

  private readonly resolved: ResolvedConfig
  private readonly runtimeStates = new WeakMap<Session, GoalRuntimeState>()

  private goalProjectionHandle!: ProjectionHandle<GoalProjectionState>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'goals')
    this.resolved = {
      defaultMaxGoalRounds: resolveMaxGoalRounds(config.defaultMaxGoalRounds ?? 256),
    }
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    this.goalProjectionHandle = await ctx.sessionProjections.register(goalProjectionDefinition)
    ctx.on('agent/created', ({ agent }) => {
      this.setActivation(agent.session, 'disarmed')
    })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'goal/change') return
      const runtime = this.runtimeState(session)
      const activation = runtime.pendingActivation !== undefined
        && SessionSeq(runtime.pendingActivation.offset) === event.seq
        ? runtime.pendingActivation.activation
        : 'disarmed'
      this.setActivation(session, activation)
    })
  }

  /**
   * Read the current goal for one exact live agent.
   * @param agent - owning live agent.
   * @returns a fresh view or `undefined` when no goal is current.
   * @throws {@link GoalError} when the agent is not the registry's live instance.
   */
  @Remote('get')
  get(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    return this.view(this.state(agent.session), this.runtimeState(agent.session))
  }

  /**
   * Remove process-local continuation authority without changing durable goal
   * phase or revision. Lifecycle owners use this before unloading a driver;
   * a later human-authorized {@link resume} records the new activation edge.
   * @param agent - owning live agent.
   * @returns a fresh disarmed view, or `undefined` when no goal is current.
   */
  disarm(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    this.setActivation(agent.session, 'disarmed')
    const runtime = this.runtimeState(agent.session)
    return this.view(this.state(agent.session), runtime)
  }

  /**
   * Create and arm a goal. A completed goal may be replaced; every other
   * current phase must be cleared or resumed instead.
   * @param agent - owning live agent.
   * @param request - objective and optional round cap.
   * @returns the created live view.
   */
  create(agent: Agent, request: CreateGoalRequest): GoalView {
    const spec = resolveCreateGoal(request, this.resolved.defaultMaxGoalRounds)
    const [state, runtime] = this.prepareMutation(agent)
    const current = state?.goal
    if (current !== undefined && current.phase !== 'complete') {
      throw new GoalError(`goal "${current.id}" already exists with phase "${current.phase}"`, 'GOAL_ALREADY_EXISTS')
    }
    const now = Date.now()
    const goal: GoalSnapshot = {
      id: GoalId(`goal-${randomUUID()}`),
      revision: 1,
      objective: spec.objective,
      phase: 'active',
      maxGoalRounds: spec.maxGoalRounds,
    }
    return this.commitSnapshot(agent, runtime, 'create', goal, 0, now, now, 'armed')
  }

  /**
   * Edit objective and/or round cap without changing phase.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param request - at least one replacement field.
   * @returns the edited view.
   */
  @Remote('edit')
  edit(agent: Agent, ref: GoalRef, request: EditGoalRequest): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    if (request.objective === undefined && request.maxGoalRounds === undefined) {
      throw new GoalError('goal edit requires objective and/or maxGoalRounds', 'GOAL_INVALID_EDIT')
    }
    const goal: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      ...request.objective === undefined ? {} : { objective: resolveObjective(request.objective) },
      ...request.maxGoalRounds === undefined ? {} : { maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds) },
    }
    return this.commitCurrent(agent, currentState, runtime, 'edit', goal, runtime.activation)
  }

  /**
   * Pause an active goal and disarm automatic continuation.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the paused view.
   */
  @Remote('pause')
  pause(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(agent, ref, 'pause', ['active'], 'paused', 'disarmed')
  }

  /**
   * Resume and arm a stopped goal, or rearm an active goal after a
   * session-start edge, while its round budget still has capacity.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the active view.
   */
  @Remote('resume')
  resume(agent: Agent, ref: GoalRef): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    const resumable: readonly GoalPhase[] = ['active', 'paused', 'blocked']
    if (!resumable.includes(current.phase)) {
      throw this.transitionError(current, 'resume', resumable)
    }
    if (current.phase === 'active' && runtime.activation === 'armed') {
      throw new GoalError(`goal "${current.id}" is already active and armed`, 'GOAL_INVALID_TRANSITION')
    }
    if (currentState.roundsStarted >= current.maxGoalRounds) {
      throw new GoalError(
        `goal "${current.id}" exhausted ${current.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
        'GOAL_INVALID_TRANSITION',
      )
    }
    return this.commitCurrent(agent, currentState, runtime, 'resume', this.withPhase(current, 'active'), 'armed')
  }

  /**
   * Mark a current non-complete goal complete and disarm it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the completed view.
   */
  @Remote('complete')
  complete(agent: Agent, ref: GoalRef): GoalView {
    const [state] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const unfinished = currentState.subgoals.filter(subgoal => subgoal.status !== 'done')
    if (unfinished.length > 0) {
      throw new GoalError(
        `goal "${currentState.goal.id}" still has ${String(unfinished.length)} unfinished subgoal(s): `
        + unfinished.map(subgoal => `${subgoal.id} ${subgoal.status}`).join(', '),
        'GOAL_SUBGOALS_OPEN',
      )
    }
    return this.transition(
      agent,
      ref,
      'complete',
      ['active', 'paused', 'blocked'],
      'complete',
      'disarmed',
    )
  }

  /**
   * Mark an active goal blocked and disarm it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param reason - policy-owned stable code and human-readable explanation.
   * @returns the blocked view with its durable reason.
   */
  block(agent: Agent, ref: GoalRef, reason: GoalBlockReason): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    if (current.phase !== 'active') {
      throw this.transitionError(current, 'block', ['active'])
    }
    return this.commitCurrent(
      agent,
      currentState,
      runtime,
      'block',
      { ...this.withPhase(current, 'blocked'), blockedReason: resolveBlockReason(reason) },
      'disarmed',
    )
  }

  /**
   * Clear the current goal while retaining a durable tombstone and history.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the tombstone ref whose revision is one past the cleared snapshot.
   */
  @Remote('clear')
  clear(agent: Agent, ref: GoalRef): GoalRef {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    const tombstone: GoalRef = { id: current.id, revision: current.revision + 1 }
    const change: GoalClearChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: this.nextMutationTime(currentState),
    }
    this.commit(agent, runtime, change, 'disarmed')
    return { ...tombstone }
  }

  /**
   * Add one per-condition child to the current goal. The child list is its own
   * durable fact stream: goal revision, phase and round budget are untouched.
   * @param agent - owning live agent.
   * @param request - condition the child tracks.
   * @returns the refreshed view with the new child last.
   */
  @Remote('addSubgoal')
  addSubgoal(agent: Agent, request: AddGoalSubgoalRequest): GoalView {
    const [state] = this.prepareMutation(agent)
    if (state === null) throw new GoalError('no current goal', 'GOAL_NOT_FOUND')
    if (state.subgoals.length >= MAX_GOAL_SUBGOALS) {
      throw new GoalError(`goal "${state.goal.id}" already carries the maximum ${String(MAX_GOAL_SUBGOALS)} subgoals`, 'GOAL_INVALID_SUBGOAL')
    }
    const subgoal: GoalSubgoal = {
      id: nextSubgoalId(state.subgoals),
      title: resolveSubgoalTitle(request.title),
      status: 'open',
    }
    return this.commitSubgoals(agent, state, 'add', [...state.subgoals.map(entry => ({ ...entry })), subgoal])
  }

  /**
   * Change one existing child's completion state and/or note.
   * @param agent - owning live agent.
   * @param request - exact child id plus at least one replacement field.
   * @returns the refreshed view.
   */
  @Remote('updateSubgoal')
  updateSubgoal(agent: Agent, request: UpdateGoalSubgoalRequest): GoalView {
    const [state] = this.prepareMutation(agent)
    if (state === null) throw new GoalError('no current goal', 'GOAL_NOT_FOUND')
    const current = state.subgoals.find(entry => entry.id === request.id)
    if (current === undefined) {
      throw new GoalError(`goal subgoal "${request.id}" does not exist`, 'GOAL_SUBGOAL_NOT_FOUND')
    }
    if (request.status === undefined && request.note === undefined) {
      throw new GoalError('goal subgoal update requires status and/or note', 'GOAL_INVALID_SUBGOAL')
    }
    const note: string | undefined = request.note === undefined
      ? current.note
      : resolveSubgoalNote(request.note)
    const next: GoalSubgoal = {
      id: current.id,
      title: current.title,
      status: request.status ?? current.status,
      ...note === undefined ? {} : { note },
    }
    return this.commitSubgoals(agent, state, 'update', state.subgoals.map(entry => (
      entry.id === next.id ? next : { ...entry }
    )))
  }

  /**
   * Remove one existing child from the current goal.
   * @param agent - owning live agent.
   * @param request - exact child id.
   * @returns the refreshed view.
   */
  @Remote('removeSubgoal')
  removeSubgoal(agent: Agent, request: RemoveGoalSubgoalRequest): GoalView {
    const [state] = this.prepareMutation(agent)
    if (state === null) throw new GoalError('no current goal', 'GOAL_NOT_FOUND')
    const remaining = state.subgoals.filter(entry => entry.id !== request.id)
    if (remaining.length === state.subgoals.length) {
      throw new GoalError(`goal subgoal "${request.id}" does not exist`, 'GOAL_SUBGOAL_NOT_FOUND')
    }
    return this.commitSubgoals(agent, state, 'remove', remaining.map(entry => ({ ...entry })))
  }

  /** Append one complete subgoal list and return the refreshed view. */
  private commitSubgoals(agent: Agent, state: GoalProjection, operation: GoalSubgoalOperation, subgoals: GoalSubgoal[]): GoalView {
    const change: GoalSubgoalChangeMeta = {
      kind: 'goal/subgoal',
      version: GOAL_CHANGE_VERSION,
      goalId: state.goal.id,
      goalRevision: state.goal.revision,
      operation,
      subgoals,
      at: Math.max(Date.now(), state.updatedAt),
    }
    agent.session.append('goal/subgoal', change)
    const view = this.view(this.state(agent.session), this.runtimeState(agent.session))
    /* v8 ignore next -- the append above commits a list scoped to the current goal. */
    if (view === undefined) throw new GoalError('no current goal', 'GOAL_NOT_FOUND')
    return view
  }

  /** Resolve the durable and process-local state used by a mutation. */
  private prepareMutation(agent: Agent): readonly [GoalProjection | null, GoalRuntimeState] {    this.assertLive(agent)
    return [this.state(agent.session), this.runtimeState(agent.session)]
  }

  /** Reject stale or missing current-state refs. */
  private expectCurrent(state: GoalProjection | null, ref: GoalRef): GoalProjection {
    if (state === null) throw new GoalError('no current goal', 'GOAL_NOT_FOUND')
    const current = state.goal
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new GoalError(
        `stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        'GOAL_STALE_REVISION',
      )
    }
    return state
  }

  /** Enforce exact live-agent identity rather than trusting a matching id. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new GoalError(`agent "${agent.id}" is not live in this registry`, 'GOAL_AGENT_NOT_LIVE')
    }
  }

  /** Read the current durable projection maintained by the registry. */
  private state(session: Session): GoalProjection | null {
    const state = this.goalProjectionHandle.stateOf(session)
    if (state.failure !== null) throw new Error(state.failure)
    return state.current
  }

  /** Return the process-local activation state, initially disarmed. */
  private runtimeState(session: Session): GoalRuntimeState {
    let runtime = this.runtimeStates.get(session)
    if (runtime !== undefined) return runtime
    runtime = {
      activation: 'disarmed',
      pendingActivation: undefined,
    }
    this.runtimeStates.set(session, runtime)
    return runtime
  }

  /** Publish one process-local activation edge when it actually changes. */
  private setActivation(session: Session, activation: GoalActivation): void {
    const runtime = this.runtimeState(session)
    if (runtime.activation === activation) return
    runtime.activation = activation
    const state = this.goalProjectionHandle.stateOf(session)
    if (state.failure !== null) return
    const goal = this.view(state.current, runtime)
    this.ctx.emit('goal/activation-changed', {
      sessionId: session.id,
      ...goal === undefined ? {} : {
        goal: {
          id: goal.id,
          revision: goal.revision,
          activation: goal.activation,
        },
      },
    })
  }

  /** Build a new revision with one replacement phase. */
  private withPhase(current: GoalSnapshot, phase: GoalPhase): GoalSnapshot {
    return {
      id: current.id,
      revision: current.revision + 1,
      objective: current.objective,
      phase,
      maxGoalRounds: current.maxGoalRounds,
    }
  }

  /** Shared validated phase transition. */
  private transition(
    agent: Agent,
    ref: GoalRef,
    operation: Exclude<GoalOperation, 'create' | 'edit' | 'clear'>,
    allowed: readonly GoalPhase[],
    phase: GoalPhase,
    activation: GoalActivation,
  ): GoalView {
    const [state, runtime] = this.prepareMutation(agent)
    const currentState = this.expectCurrent(state, ref)
    const current = currentState.goal
    if (!allowed.includes(current.phase)) throw this.transitionError(current, operation, allowed)
    return this.commitCurrent(agent, currentState, runtime, operation, this.withPhase(current, phase), activation)
  }

  /** Render a stable invalid-transition error. */
  private transitionError(current: GoalSnapshot, operation: GoalOperation, allowed: readonly GoalPhase[]): GoalError {
    return new GoalError(
      `cannot ${operation} goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      'GOAL_INVALID_TRANSITION',
    )
  }

  /** Commit a mutation that retains the current goal's derived counters/times. */
  private commitCurrent(
    agent: Agent,
    state: GoalProjection,
    runtime: GoalRuntimeState,
    operation: Exclude<GoalOperation, 'create' | 'clear'>,
    goal: GoalSnapshot,
    activation: GoalActivation,
  ): GoalView {
    return this.commitSnapshot(
      agent,
      runtime,
      operation,
      goal,
      state.roundsStarted,
      state.createdAt,
      this.nextMutationTime(state),
      activation,
    )
  }

  /** Clamp a current goal's next timestamp across backward wall-clock movement. */
  private nextMutationTime(state: GoalProjection): number {
    return Math.max(Date.now(), state.updatedAt)
  }

  /** Build and commit one full-snapshot mutation. */
  private commitSnapshot(
    agent: Agent,
    runtime: GoalRuntimeState,
    operation: Exclude<GoalOperation, 'clear'>,
    goal: GoalSnapshot,
    roundsStarted: number,
    createdAt: number,
    updatedAt: number,
    activation: GoalActivation,
  ): GoalView {
    const change: GoalSnapshotChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation,
      goal,
      roundsStarted,
      createdAt,
      updatedAt,
    }
    this.commit(agent, runtime, change, activation)
    const view = this.view(this.state(agent.session), runtime)
    /* v8 ignore next -- the commit above just committed a current goal. */
    if (view === undefined) throw new Error('goal commit produced no current goal')
    return view
  }

  /** Commit one mutation into the goal log and live event stream. */
  private commit(agent: Agent, runtime: GoalRuntimeState, change: GoalChangeMeta, activation: GoalActivation): void {
    const ref = goalChangeRef(change)
    runtime.pendingActivation = { offset: agent.session.seq, activation }
    try {
      const event = agent.session.append('goal/change', change)
      /* v8 ignore next -- Session.append returns the event committed at the pre-append seq. */
      if (SessionSeq(runtime.pendingActivation.offset) === event.seq) runtime.activation = activation
    } finally {
      runtime.pendingActivation = undefined
    }
    const goal = this.view(this.state(agent.session), runtime)
    const notification: GoalChanged = {
      operation: change.operation,
      ref: { ...ref },
      ...goal === undefined ? {} : { goal },
    }
    agentEvents(this.ctx, agent).emit('goal/changed', { change: notification })
  }

  /** Build a detached current view. */
  private view(state: GoalProjection | null, runtime: GoalRuntimeState): GoalView | undefined {
    if (state === null) return undefined
    return {
      ...state.goal,
      roundsStarted: state.roundsStarted,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      activation: runtime.activation,
      subgoals: state.subgoals.map(subgoal => ({ ...subgoal })),
    }
  }

  /**
   * Create one Goal through the remote boundary.
   * @param agent - exact live Agent resolved from the wire identity.
   * @param request - objective and optional round cap.
   * @returns the created Goal identity.
   */
  @Remote('create')
  remoteExportCreate(agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    const view = this.create(agent, request)
    return { ref: { id: view.id, revision: view.revision } }
  }
}

export default GoalService
