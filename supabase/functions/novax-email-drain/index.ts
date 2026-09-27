import { createHandler } from './worker.ts';

Deno.serve(createHandler({
  url: Deno.env.get('SUPABASE_URL') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  resendKey: Deno.env.get('RESEND_API_KEY') ?? '',
  drainToken: Deno.env.get('NOVAX_EMAIL_DRAIN_TOKEN') ?? Deno.env.get('DRAIN_TOKEN') ?? '',
}));
