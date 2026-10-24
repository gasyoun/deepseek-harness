/**
 * Model-facing `get_goal`, `create_goal`, and `update_goal` tools over the
 * persisted same-session goal domain.
 * @module @deepseek-ai/dsh-tool-goal
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { boundContextSummary, createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tool-goal': { kind: 'tool-goal' } & ContextFormed
  }
}

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import {
  completionAuthority,
  goalToolExecution,
  requireDirectHuman,
} from './authority.ts'
import { renderWrapupContext } from './wrapup.ts'

export const name = 'tool-goal'
export const inject = ['agents', 'goals', 'tools', 'systemPrompt']

/** Model policy and hard lower bounds for goal-state updates. */
export interface Config {
  /** Minimum admitted goal rounds before the model may self-report `blocked`. */
  blockedAfterConsecutiveRounds?: number
}

/** Schemastery config for the goal-tool policy. */
export const Config: z<Config> = z.object({
  blockedAfterConsecutiveRounds: z.number().step(1).min(1).default(3),
})

/** Fully materialized tool policy. */
interface ResolvedConfig {
  readonly blockedAfterConsecutiveRounds: number
}

type UpdateAction =
  | 'edit'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'blocked'
  | 'add_subgoal'
  | 'update_subgoal'
  | 'remove_subgoal'

const UPDATE_ACTIONS: UpdateAction[] = [
  'edit',
  'pause',
  'resume',
  'complete',
  'blocked',
  'add_subgoal',
  'update_subgoal',
  'remove_subgoal',
]

const SUBGOAL_STATUSES = ['open', 'done', 'blocked'] as const

const CREATE_DESCRIPTION =
  'Create a persisted goal that keeps this session working across automatic continuation rounds. '
  + 'Use it when the direct human request is a long-running objective, even if the user did not say "goal"; '
  + 'not for single-turn work.'

const GET_DESCRIPTION = 'Read the current session goal, including the id and revision that update_goal requires.'

/** Canonical goal-tool output, matching the existing compact Native JSON. */
type GoalToolValue =
  | { goal: null }
  | {
    goal: {
      id: string
      revision: number
      objective: string
      phase: GoalView['phase']
      roundsStarted: number
      maxGoalRounds: number
      blockedReason?: { code: string; message: string }
      subgoals: {
        id: string
        title: string
        status: 'open' | 'done' | 'blocked'
        note?: string
      }[]
    }
    activation: GoalView['activation']
  }

const GOAL_VALUE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'null', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            id: { type: 'string', required: true },
            revision: { type: 'integer', required: true },
            objective: { type: 'string', required: true },
            phase: { type: 'string', required: true, enum: ['active', 'paused', 'blocked', 'complete'] },
            roundsStarted: { type: 'integer', required: true },
            maxGoalRounds: { type: 'integer', required: true },
            blockedReason: {
              type: 'object',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
            subgoals: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  status: { type: 'string', required: true, enum: [...SUBGOAL_STATUSES] },
                  note: { type: 'string' },
                },
              },
            },
          },
        },
        activation: { type: 'string', required: true, enum: ['armed', 'disarmed'] },
      },
    },
  ],
} as const

/** Render policy guidance with its deployment-selected blocked threshold. */
function guidance(blockedAfter: number): string {
  return 'create_goal may infer goal intent from a direct human request in any language. '
    + 'After session resume or fork, an active goal is disarmed: when '
    + 'a human asks to continue or resume in any wording or language, use update_goal action '
    + 'resume to rearm it. Mark complete only when the objective is actually achieved. Mark '
    + `blocked only after the same blocking condition persists for at least ${blockedAfter} `
    + 'consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, '
    + 'or useful remaining work is not blocked. Subgoals are per-condition checks: add_subgoal while '
    + 'planning, update_subgoal as each closes; complete needs all of them done.'
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const blockedAfter = config.blockedAfterConsecutiveRounds ?? 3
  if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) {
    throw new TypeError('blockedAfterConsecutiveRounds must be a positive safe integer')
  }
  return { blockedAfterConsecutiveRounds: blockedAfter }
}

/** Whether optional text is meaningful rather than a strict-schema empty filler. */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

/** Whether an optional round cap is meaningful rather than a strict-schema zero filler. */
function hasRoundCap(value: number | undefined): value is number {
  return value !== undefined && value !== 0
}

/** Build the exact compare-and-set ref from model arguments. */
function goalRef(goalId: string, revision: number): GoalRef {
  if (goalId.length === 0 || goalId !== goalId.trim()
    || !Number.isSafeInteger(revision) || revision < 1) {
    throw new HarnessError(
      'goal_id must be non-empty and revision must be a positive safe integer',
      'GOAL_TOOL_INVALID_UPDATE',
    )
  }
  return { id: GoalId(goalId), revision }
}

/** Stable compact model result; activation is an observation, not replay state. */
function goalValue(goal: GoalView | undefined): GoalToolValue {
  if (goal === undefined) return { goal: null }
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...goal.blockedReason === undefined ? {} : {
        blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message },
      },
      subgoals: goal.subgoals.map(subgoal => ({
        id: subgoal.id,
        title: subgoal.title,
        status: subgoal.status,
        ...subgoal.note === undefined ? {} : { note: subgoal.note },
      })),
    },
    activation: goal.activation,
  }
}

/** Reusable canonical output declaration for all three goal controls. */
const GOAL_OUTPUT = {
  schema: GOAL_VALUE_SCHEMA,
  render: (_args: unknown, value: GoalToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Generic, args-only pending presentation shared by the goal tools. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Register the three Codex-shaped goal tools and their shared policy section. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:goal',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
    text: guidance(resolved.blockedAfterConsecutiveRounds),
  })

  ctx.tools.register(defineTool({
    name: 'get_goal',
    description: GET_DESCRIPTION,
    parameters: {},
    output: GOAL_OUTPUT,
    execute(_args, exec) {
      const execution = goalToolExecution(ctx, exec)
      return Promise.resolve(goalValue(ctx.goals.get(execution.agent)))
    },
    presentCall: () => present('Read current goal', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'create_goal',
    description: CREATE_DESCRIPTION,
    parameters: {
      objective: {
        type: 'string',
        required: true,
        description: 'The concrete completion objective inferred from the direct human request.',
      },
      max_goal_rounds: {
        type: 'number',
        description: 'Optional positive safe-integer limit on automatic continuation rounds.',
      },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) {
      const execution = goalToolExecution(ctx, exec)
      requireDirectHuman(ctx, execution)
      const goal = ctx.goals.create(execution.agent, {
        objective: args.objective,
        ...args.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds },
      })
      return Promise.resolve(goalValue(goal))
    },
    presentCall: args => present('Create goal', 'other', args.objective),
  }))

  ctx.tools.register(defineTool({
    name: 'update_goal',
    description: 'Update the current goal.',
    parameters: {
      goal_id: { type: 'string', required: true, description: 'Exact id returned by get_goal.' },
      revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_goal.' },
      action: {
        type: 'string',
        required: true,
        enum: UPDATE_ACTIONS,
        description: 'edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed '
          + 'during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.',
      },
      objective: { type: 'string', description: 'Replacement objective; valid only with action edit.' },
      max_goal_rounds: { type: 'number', description: 'Replacement cap; valid only with action edit.' },
      blocked_reason: {
        type: 'string',
        description: 'Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.',
      },
      subgoal_title: {
        type: 'string',
        description: 'Condition the child tracks (add_subgoal).',
      },
      subgoal_id: {
        type: 'string',
        description: 'Child id from get_goal (update/remove).',
      },
      subgoal_status: {
        type: 'string',
        enum: [...SUBGOAL_STATUSES],
        description: 'New child state (update_subgoal).',
      },
      subgoal_note: {
        type: 'string',
        description: 'Why; empty clears (update_subgoal).',
      },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) {
      const execution = goalToolExecution(ctx, exec)
      const ref = goalRef(args.goal_id, args.revision)
      const replacements = {
        ...hasText(args.objective) ? { objective: args.objective } : {},
        ...hasRoundCap(args.max_goal_rounds) ? { maxGoalRounds: args.max_goal_rounds } : {},
      }
      if (args.action === 'edit') {
        requireDirectHuman(ctx, execution)
        if (hasText(args.blocked_reason)) {
          throw new HarnessError('blocked_reason is valid only with action blocked', 'GOAL_TOOL_INVALID_UPDATE')
        }
        const goal = ctx.goals.edit(execution.agent, ref, replacements)
        return Promise.resolve(goalValue(goal))
      }
      if (args.action === 'pause' || args.action === 'resume') {
        requireDirectHuman(ctx, execution)
        if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds) || hasText(args.blocked_reason)) {
          throw new HarnessError(
            'objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked',
            'GOAL_TOOL_INVALID_UPDATE',
          )
        }
        const current = ctx.goals.get(execution.agent)
        if (args.action === 'resume' && current?.id === ref.id && current.revision === ref.revision
          && current.phase === 'paused') {
          throw new HarnessError(
            'the model cannot resume a paused goal; the user must resume it',
            'GOAL_TOOL_RESUME_PAUSED',
          )
        }
        const goal = args.action === 'pause'
          ? ctx.goals.pause(execution.agent, ref)
          : ctx.goals.resume(execution.agent, ref)
        return Promise.resolve(goalValue(goal))
      }
      if (args.action === 'add_subgoal' || args.action === 'update_subgoal' || args.action === 'remove_subgoal') {
        if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds) || hasText(args.blocked_reason)) {
          throw new HarnessError(
            'objective, max_goal_rounds and blocked_reason are not valid with a subgoal action',
            'GOAL_TOOL_INVALID_UPDATE',
          )
        }
        if (args.action === 'add_subgoal') {
          if (!hasText(args.subgoal_title)) {
            throw new HarnessError('subgoal_title is required with action add_subgoal', 'GOAL_TOOL_INVALID_UPDATE')
          }
          return Promise.resolve(goalValue(ctx.goals.addSubgoal(execution.agent, { title: args.subgoal_title })))
        }
        if (!hasText(args.subgoal_id)) {
          throw new HarnessError(
            `subgoal_id is required with action ${args.action}`,
            'GOAL_TOOL_INVALID_UPDATE',
          )
        }
        if (args.action === 'remove_subgoal') {
          if (args.subgoal_status !== undefined || args.subgoal_note !== undefined) {
            throw new HarnessError(
              'subgoal_status and subgoal_note are not valid with action remove_subgoal',
              'GOAL_TOOL_INVALID_UPDATE',
            )
          }
          return Promise.resolve(goalValue(ctx.goals.removeSubgoal(execution.agent, { id: args.subgoal_id })))
        }
        if (args.subgoal_status === undefined && args.subgoal_note === undefined) {
          throw new HarnessError(
            'action update_subgoal requires subgoal_status and/or subgoal_note',
            'GOAL_TOOL_INVALID_UPDATE',
          )
        }
        const note = args.subgoal_note === undefined
          ? undefined
          : args.subgoal_note === '' ? null : args.subgoal_note
        return Promise.resolve(goalValue(ctx.goals.updateSubgoal(execution.agent, {
          id: args.subgoal_id,
          ...args.subgoal_status === undefined ? {} : { status: args.subgoal_status },
          ...note === undefined ? {} : { note },
        })))
      }
      const authority = completionAuthority(ctx, execution)
      if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds)) {
        throw new HarnessError(
          'objective and max_goal_rounds are valid only with action edit',
          'GOAL_TOOL_INVALID_UPDATE',
        )
      }
      if (args.action === 'complete' && hasText(args.blocked_reason)) {
        throw new HarnessError('blocked_reason is valid only with action blocked', 'GOAL_TOOL_INVALID_UPDATE')
      }
      if (args.action === 'blocked'
        && (args.blocked_reason === undefined || args.blocked_reason.trim().length === 0)) {
        throw new HarnessError('blocked_reason is required with action blocked', 'GOAL_TOOL_INVALID_UPDATE')
      }
      if (args.action === 'blocked' && authority.kind === 'goal-round'
        && authority.goal.roundsStarted < resolved.blockedAfterConsecutiveRounds) {
        throw new HarnessError(
          `blocked requires at least ${resolved.blockedAfterConsecutiveRounds} consecutive goal rounds; `
          + `current round is ${authority.goal.roundsStarted}`,
          'GOAL_TOOL_BLOCK_THRESHOLD',
        )
      }
      const goal = args.action === 'complete'
        ? ctx.goals.complete(execution.agent, ref)
        : ctx.goals.block(execution.agent, ref, {
          code: 'model-reported',
          message: args.blocked_reason as string,
        })
      if (authority.kind === 'goal-round') {
        exec.deferContext(createUserMessage({
          content: args.action === 'complete'
            ? renderWrapupContext(goal.objective)
            : renderWrapupContext(goal.objective, args.blocked_reason as string),
          source: {
            kind: 'tool-goal',
            form: 'notice',
            summary: boundContextSummary(`${args.action as string}: ${goal.objective}`),
          },
        }))
      }
      return Promise.resolve(goalValue(goal))
    },
    presentCall: (args) => {
      const title = args.action === 'add_subgoal' ? 'Add goal subgoal'
        : args.action === 'update_subgoal' ? 'Update goal subgoal'
          : args.action === 'remove_subgoal' ? 'Remove goal subgoal'
            : `${args.action === 'blocked' ? 'Mark' : args.action.charAt(0).toUpperCase() + args.action.slice(1)} goal`
      if (hasText(args.subgoal_title)) return present(title, 'other', args.subgoal_title)
      if (hasText(args.subgoal_id)) return present(title, 'other', args.subgoal_id)
      return present(
        title,
        'other',
        hasText(args.blocked_reason)
          ? args.blocked_reason
          : hasText(args.objective)
            ? args.objective
            : hasRoundCap(args.max_goal_rounds) ? args.max_goal_rounds : args.goal_id,
      )
    },
  }))
}
