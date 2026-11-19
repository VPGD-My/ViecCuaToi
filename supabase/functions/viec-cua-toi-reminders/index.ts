// Edge Function: viec-cua-toi-reminders
// Chạy định kỳ (pg_cron gọi 5 phút một lần), tìm việc đến giờ nhắc và gửi thông báo đẩy.
//
// Biến môi trường (supabase secrets set ...):
//   VIEC_CUA_TOI_VAPID_PUBLIC_KEY, VIEC_CUA_TOI_VAPID_PRIVATE_KEY, VIEC_CUA_TOI_VAPID_SUBJECT
//   VIEC_CUA_TOI_CRON_SECRET          chuỗi bí mật, cron phải gửi kèm header x-cron-secret
//   VIEC_CUA_TOI_REMIND_BEFORE_MIN    nhắc trước giờ hạn bao nhiêu phút (mặc định 15, 0 = đúng giờ)
//   VIEC_CUA_TOI_MORNING_TIME         giờ nhắc buổi sáng cho việc không có giờ (mặc định 07:30)
// SUPABASE_URL và SUPABASE_SERVICE_ROLE_KEY do Supabase tự cung cấp.
// Mọi biến đều có tiền tố VIEC_CUA_TOI_ để không đụng biến của project khác dùng chung.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;
const LEAD_MIN = Number(env('VIEC_CUA_TOI_REMIND_BEFORE_MIN', '15'));
const MORNING = env('VIEC_CUA_TOI_MORNING_TIME', '07:30');
const CRON_SECRET = env('VIEC_CUA_TOI_CRON_SECRET');

webpush.setVapidDetails(
  env('VIEC_CUA_TOI_VAPID_SUBJECT', 'mailto:admin@example.com'),
  env('VIEC_CUA_TOI_VAPID_PUBLIC_KEY'),
  env('VIEC_CUA_TOI_VAPID_PRIVATE_KEY'),
);

type Claimed = { log_id: number; task_id: string; owner_id: string; kind: 'due_time' | 'morning'; remind_at: string; time_zone: string };
type Task = { id: string; title: string; space: 'work' | 'home'; priority: number; due_date: string; due_time: string | null; is_done: boolean; is_deleted: boolean };
type Sub = { id: string; owner_id: string; endpoint: string; p256dh: string; auth_key: string; failure_count: number };

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function buildMessage(t: Task, kind: Claimed['kind']) {
  const group = t.space === 'work' ? 'Công việc' : 'Cá nhân';
  const imp = t.priority === 1 ? 'Quan trọng · ' : '';
  if (kind === 'due_time' && t.due_time) {
    const hhmm = t.due_time.slice(0, 5);
    return {
      title: t.title,
      body: `${imp}${group}, đến hạn lúc ${hhmm}`,
    };
  }
  return {
    title: t.title,
    body: `${imp}${group}, cần xong trong hôm nay`,
  };
}

async function run() {
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    db: { schema: 'viec_cua_toi' },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: claimed, error } = await db.rpc('claim_due_reminders', {
    p_lead_minutes: LEAD_MIN,
    p_morning: MORNING,
    p_window_minutes: 120,
    p_limit: 500,
  });
  if (error) throw error;
  const list = (claimed ?? []) as Claimed[];
  if (!list.length) return { claimed: 0, sent: 0 };

  const taskIds = [...new Set(list.map((c) => c.task_id))];
  const ownerIds = [...new Set(list.map((c) => c.owner_id))];

  const [{ data: tasks, error: te }, { data: subs, error: se }] = await Promise.all([
    db.from('tasks').select('id,title,space,priority,due_date,due_time,is_done,is_deleted').in('id', taskIds),
    db.from('push_subscriptions').select('id,owner_id,endpoint,p256dh,auth_key,failure_count').in('owner_id', ownerIds).eq('is_deleted', false),
  ]);
  if (te) throw te;
  if (se) throw se;

  const taskById = new Map((tasks as Task[]).map((t) => [t.id, t]));
  const subsByOwner = new Map<string, Sub[]>();
  for (const s of subs as Sub[]) subsByOwner.set(s.owner_id, [...(subsByOwner.get(s.owner_id) ?? []), s]);

  let sentTotal = 0;
  for (const c of list) {
    const t = taskById.get(c.task_id);
    const devices = subsByOwner.get(c.owner_id) ?? [];
    if (!t || t.is_done || t.is_deleted) {
      await db.from('reminder_log').update({ status: 'failed', detail: 'Việc đã xong hoặc đã xoá trước khi gửi' }).eq('id', c.log_id);
      continue;
    }
    if (!devices.length) {
      await db.from('reminder_log').update({ status: 'no_device' }).eq('id', c.log_id);
      continue;
    }
    const msg = buildMessage(t, c.kind);
    const payload = JSON.stringify({ ...msg, tag: 'task-' + t.id, taskId: t.id, important: t.priority === 1 });
    let ok = 0;
    const errors: string[] = [];
    for (const s of devices) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload,
          { TTL: 60 * 60 * 6, urgency: t.priority === 1 ? 'high' : 'normal', topic: ('t' + t.id.replace(/-/g, '')).slice(0, 32) },
        );
        ok++;
        if (s.failure_count) await db.from('push_subscriptions').update({ failure_count: 0, last_error: null }).eq('id', s.id);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode ?? 0;
        errors.push(String(code || (e as Error).message).slice(0, 80));
        // 404/410: thiết bị đã gỡ quyền hoặc hết hạn -> xoá mềm
        const gone = code === 404 || code === 410;
        await db
          .from('push_subscriptions')
          .update({
            failure_count: Math.min(s.failure_count + 1, 32000),
            last_error: String(code || (e as Error).message).slice(0, 300),
            ...(gone || s.failure_count + 1 >= 10 ? { is_deleted: true } : {}),
          })
          .eq('id', s.id);
      }
    }
    sentTotal += ok;
    await db
      .from('reminder_log')
      .update({ status: ok ? 'sent' : 'failed', devices_sent: ok, detail: errors.length ? errors.join(', ').slice(0, 500) : null })
      .eq('id', c.log_id);
  }
  return { claimed: list.length, sent: sentTotal };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!safeEqual(req.headers.get('x-cron-secret') ?? '', CRON_SECRET)) return new Response('Forbidden', { status: 403 });
  try {
    const result = await run();
    return Response.json(result);
  } catch (e) {
    console.error(e);
    return Response.json({ error: (e as Error).message ?? 'error' }, { status: 500 });
  }
});
