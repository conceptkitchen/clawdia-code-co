-- Migration: expand_memory_types
-- Expand memory.type CHECK constraint from 4 types to 11
-- Original: fact, goal, completed_goal, preference
-- Added: rule, session, person, skill, project, lesson, decision

ALTER TABLE public.memory DROP CONSTRAINT IF EXISTS memory_type_check;

ALTER TABLE public.memory ADD CONSTRAINT memory_type_check
  CHECK (type = ANY (ARRAY[
    'fact', 'goal', 'completed_goal', 'preference',
    'rule', 'session', 'person', 'skill', 'project', 'lesson', 'decision'
  ]));
