import { z } from 'zod';

export const statusSchema = z.enum(['completed', 'in_progress', 'planned']);
export const growthItemSchema = z.object({
  id: z.string().optional(), op: z.enum(['create', 'update', 'archive', 'restore', 'move']),
  title: z.string().trim().min(1).max(180), category: z.string().trim().min(1).max(60).default('其他'),
  status: statusSchema, description: z.string().max(4000).default(''), priority: z.number().int().min(1).max(3).default(2),
  startedOn: z.string().nullable().default(null), dueOn: z.string().nullable().default(null), completedOn: z.string().nullable().default(null),
  nextAction: z.string().max(500).default(''), link: z.string().max(1000).default(''), goalTitle: z.string().max(180).default(''),
});
export const growthProposalSchema = z.object({ clarification: z.string().default(''), suggestions: z.array(growthItemSchema).max(20) });
export const dailyTaskSchema = z.object({ title: z.string().trim().min(1).max(180), estimateMinutes: z.number().int().min(5).max(720), priority: z.number().int().min(1).max(3), completionCriteria: z.string().max(500).default(''), itemId: z.string().nullable().default(null) });
export const dailyProposalSchema = z.object({ clarification: z.string().default(''), tasks: z.array(dailyTaskSchema).max(30) });
export const dailyReplanSchema = z.object({ clarification: z.string().default(''), tasks: z.array(z.object({ id: z.string(), estimateMinutes: z.number().int().min(5).max(720) })).max(30) });
