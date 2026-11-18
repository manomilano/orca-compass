/**
 * Need levels and effort demands for the "Rate a job" explainer.
 *
 * The definitions are copied word for word from the tables in
 * `skills/orcacompass/SKILL.md` ("Rate the three needs" and "Rate the effort
 * demand separately"). Keep them identical: when the Skill changes, change
 * these strings in the same commit. Level names follow `src/routing/needs.ts`
 * (NEEDS) and the `--demand` values of `orcacompass route`.
 */

export type NeedLevel = 'min' | 'low' | 'mid' | 'high' | 'top'
export type Demand = 'low' | 'moderate' | 'high' | 'exceptional'
export type AxisId = 'coding' | 'agentic' | 'reasoning'

export const NEED_LEVELS: readonly NeedLevel[] = ['min', 'low', 'mid', 'high', 'top']
export const DEMANDS: readonly Demand[] = ['low', 'moderate', 'high', 'exceptional']

export interface AxisInfo {
  id: AxisId
  /** Axis name as written in the Skill's table heading. */
  name: string
  /** What the axis measures, from the Skill's table heading. */
  measures: string
  definitions: Record<NeedLevel, string>
}

export const AXES: readonly AxisInfo[] = [
  {
    id: 'coding',
    name: 'Coding',
    measures: 'implementation difficulty',
    definitions: {
      min: 'No coding capability required.',
      low: 'Straightforward code changes using familiar patterns, clear instructions, and limited technical decisions.',
      mid: 'Non-trivial implementation requiring understanding of existing code, interactions between components, or moderate technical judgment.',
      high: 'Complex implementation requiring deep code understanding, challenging debugging, intricate logic, or significant architectural decisions.',
      top: 'Exceptional engineering challenges involving unusually difficult algorithms, subtle system-wide invariants, or highly complex interactions where advanced coding expertise is essential.',
    },
  },
  {
    id: 'agentic',
    name: 'Agentic',
    measures: 'autonomy and adaptive execution',
    definitions: {
      min: 'No autonomous execution or tool use required.',
      low: 'Simple, predictable actions with clear steps and completion criteria.',
      mid: 'Multi-step work requiring independent tool use, iteration, and adaptation to routine results or failures.',
      high: 'Complex autonomous workflows requiring investigation, independent planning, coordination, and recovery from unexpected obstacles.',
      top: 'Exceptional autonomous execution involving deeply interdependent tasks, substantial uncertainty, dynamic replanning, and sophisticated coordination across tools or workers.',
    },
  },
  {
    id: 'reasoning',
    name: 'Reasoning',
    measures: 'cognitive problem-solving difficulty',
    definitions: {
      min: 'Mechanical or deterministic tasks requiring virtually no judgment.',
      low: 'Familiar problems with obvious solutions and straightforward decisions.',
      mid: 'Problems requiring meaningful analysis, comparison of alternatives, or reasoning through multiple constraints.',
      high: 'Difficult, ambiguous problems requiring deep analysis, non-obvious deductions, or sophisticated multi-step reasoning.',
      top: 'Exceptional reasoning challenges involving novel problems, highly complex interacting constraints, or solutions that demand unusually deep insight beyond established approaches.',
    },
  },
]

/** The Skill's "Signals" column for each effort demand. */
export const DEMAND_SIGNALS: Record<Demand, string> = {
  low: 'The steps are known; checking the result is easy.',
  moderate: 'Some local choices or a little diagnosis.',
  high: 'Ambiguity, an unknown cause, trade-offs, constraints across components, or a plan to make.',
  exceptional: 'Several of those at once, with costly failure.',
}

/** Server-rendered default: the Skill's own example rating. */
export const DEFAULT_NEEDS: Record<AxisId, NeedLevel> = { coding: 'mid', agentic: 'low', reasoning: 'low' }
export const DEFAULT_DEMAND: Demand = 'moderate'

/** The exact `orcacompass route` call a rating produces. */
export function routeCommand(needs: Record<AxisId, NeedLevel>, demand: Demand): string {
  const need = AXES.map((axis) => `${axis.id}=${needs[axis.id]}`).join(',')
  return `orcacompass route --need ${need} --demand ${demand} --json`
}
