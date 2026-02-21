-- Migration: create_feedback_table
-- Adds feedback signal tracking and prompt metrics tables

-- ============================================================
-- FEEDBACK TABLE (Implicit signals from user behavior)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.feedback (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ DEFAULT now(),
  message_id    UUID,
  signal_type   TEXT NOT NULL,
  signal_source TEXT NOT NULL,
  signal_value  DOUBLE PRECISION DEFAULT 0,
  context_loaded JSONB DEFAULT '{}',
  notes         TEXT,
  metadata      JSONB DEFAULT '{}'
);

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON public.feedback
  FOR ALL USING (true);

-- ============================================================
-- PROMPT METRICS TABLE (Periodic performance snapshots)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.prompt_metrics (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at             TIMESTAMPTZ DEFAULT now(),
  period_start           TIMESTAMPTZ NOT NULL,
  period_end             TIMESTAMPTZ NOT NULL,
  total_interactions     INTEGER DEFAULT 0,
  positive_signals       INTEGER DEFAULT 0,
  negative_signals       INTEGER DEFAULT 0,
  corrections            INTEGER DEFAULT 0,
  action_approval_rate   DOUBLE PRECISION,
  avg_response_length    DOUBLE PRECISION,
  context_sections_loaded JSONB DEFAULT '{}',
  insights               TEXT,
  prompt_changes         TEXT
);

ALTER TABLE public.prompt_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON public.prompt_metrics
  FOR ALL USING (true);
