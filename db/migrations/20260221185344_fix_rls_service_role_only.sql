-- Migration: fix_rls_service_role_only
-- Replaces permissive USING(true) policies with service_role-only access
-- Prevents anon key from reading any data — only the relay backend (service role) can access

DROP POLICY IF EXISTS "Allow all for service role" ON public.messages;
DROP POLICY IF EXISTS "Allow all for service role" ON public.memory;
DROP POLICY IF EXISTS "Allow all for service role" ON public.logs;
DROP POLICY IF EXISTS "Allow all for service role" ON public.feedback;
DROP POLICY IF EXISTS "Allow all for service role" ON public.prompt_metrics;

CREATE POLICY "Service role only" ON public.messages
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role only" ON public.memory
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role only" ON public.logs
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role only" ON public.feedback
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role only" ON public.prompt_metrics
  FOR ALL USING (auth.role() = 'service_role');
