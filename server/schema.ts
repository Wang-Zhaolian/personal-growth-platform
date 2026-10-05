import { z } from 'zod';

export const statusSchema = z.enum(['completed', 'in_progress', 'planned']);
export const growthItemSchema = z.object({
  id: z.string().nullable().optional(), op: z.enum(['create', 'update', 'archive', 'restore', 'move']),
  expectedVersion: z.number().int().nonnegative().optional(),
  title: z.string().trim().min(1).max(180), category: z.string().trim().min(1).max(60).optional(),
  status: statusSchema, description: z.string().max(4000).optional(), priority: z.number().int().min(1).max(3).optional(),
  startedOn: z.string().nullable().optional(), dueOn: z.string().nullable().optional(), completedOn: z.string().nullable().optional(),
  progressPercent: z.number().int().min(0).max(100).nullable().optional(),
  progressNote: z.string().max(500).optional(),
  progressSource: z.enum(['user_reported', 'ai_estimate']).nullable().optional(),
  nextAction: z.string().max(500).optional(), link: z.string().max(1000).optional(), goalTitle: z.string().max(180).optional(),
});
export const growthProposalSchema = z.object({ clarification: z.string().default(''), suggestions: z.array(growthItemSchema).max(20) });
export const dailyTaskSchema = z.object({ title: z.string().trim().min(1).max(180), estimateMinutes: z.number().int().min(5).max(720), priority: z.number().int().min(1).max(3), completionCriteria: z.string().max(500).default(''), itemId: z.string().nullable().default(null) });
export const dailyProposalSchema = z.object({ clarification: z.string().default(''), tasks: z.array(dailyTaskSchema).max(30) });
export const dailyReplanSchema = z.object({ clarification: z.string().default(''), tasks: z.array(z.object({ id: z.string(), estimateMinutes: z.number().int().min(5).max(720) })).max(30) });
