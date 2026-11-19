// Lớp dữ liệu: mọi đọc/ghi Supabase của app nằm ở đây.
// App chỉ làm việc với schema riêng "viec_cua_toi", không đụng tới schema của project khác.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(url && anonKey);

export const supabase = configured
  ? createClient(url, anonKey, {
      db: { schema: 'viec_cua_toi' },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Khoá lưu phiên riêng, không lẫn với app khác dùng chung project Supabase trên cùng tên miền
        storageKey: 'viec-cua-toi-auth',
      },
    })
  : null;

// Chỉ lấy cột cần dùng (không SELECT *)
const COLS = 'id,space,title,note,due_date,due_time,priority,subtasks,is_done,done_at,created_at,is_deleted';
const OPEN_LIMIT = 1000; // việc chưa xong
export const DONE_PAGE = 200; // việc đã xong gần nhất

const pad = (n) => String(n).padStart(2, '0');
const localDate = (iso) => {
  const d = new Date(iso);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};

/** Hàng trong DB -> đối tượng việc mà giao diện dùng */
export function fromRow(r) {
  return {
    id: r.id,
    space: r.space,
    title: r.title,
    note: r.note || '',
    due: r.due_date || '',
    time: r.due_time ? r.due_time.slice(0, 5) : '',
    priority: r.priority,
    subtasks: Array.isArray(r.subtasks) ? r.subtasks : [],
    done: r.is_done,
    doneAt: r.done_at ? Date.parse(r.done_at) : null,
    doneOn: r.done_at ? localDate(r.done_at) : null,
    createdAt: Date.parse(r.created_at),
  };
}

/** Đối tượng việc -> hàng gửi lên DB. Cột audit, done_at, deleted_* do trigger tự điền. */
function toRow(t, ownerId) {
  return {
    id: t.id,
    owner_id: ownerId,
    space: t.space === 'home' ? 'home' : 'work',
    title: String(t.title || '').trim().slice(0, 200),
    note: t.note ? String(t.note).slice(0, 4000) : null,
    due_date: t.due || null,
    due_time: t.due && t.time ? t.time : null,
    priority: [1, 2, 3].includes(t.priority) ? t.priority : 2,
    subtasks: (t.subtasks || []).slice(0, 50).map((s) => ({ text: String(s.text || '').slice(0, 300), done: !!s.done })),
    is_done: !!t.done,
    is_deleted: false,
  };
}

export async function fetchTasks() {
  const open = await supabase
    .from('tasks')
    .select(COLS)
    .eq('is_deleted', false)
    .eq('is_done', false)
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(OPEN_LIMIT);
  if (open.error) throw open.error;

  const done = await supabase
    .from('tasks')
    .select(COLS)
    .eq('is_deleted', false)
    .eq('is_done', true)
    .order('done_at', { ascending: false })
    .limit(DONE_PAGE);
  if (done.error) throw done.error;

  return [...open.data, ...done.data].map(fromRow);
}

/** Thêm mới, cập nhật, hoặc khôi phục (hoàn tác xoá) một việc */
export async function saveTask(task, ownerId) {
  const { data, error } = await supabase
    .from('tasks')
    .upsert(toRow(task, ownerId), { onConflict: 'id' })
    .select(COLS)
    .single();
  if (error) throw error;
  return fromRow(data);
}

/** Xoá mềm: chỉ đánh dấu is_deleted, không bao giờ DELETE */
export async function softDeleteTasks(ids) {
  if (!ids.length) return;
  const { error } = await supabase
    .from('tasks')
    .update({ is_deleted: true })
    .in('id', ids)
    .eq('is_deleted', false);
  if (error) throw error;
}

/** Nhận thay đổi thời gian thực từ thiết bị khác của cùng người dùng */
export function subscribeTasks(ownerId, onRow, onStatus) {
  const channel = supabase
    .channel('viec-cua-toi-tasks-' + ownerId)
    .on(
      'postgres_changes',
      { event: '*', schema: 'viec_cua_toi', table: 'tasks', filter: 'owner_id=eq.' + ownerId },
      (payload) => payload.new && payload.new.id && onRow(payload.new),
    )
    .subscribe((status) => onStatus && onStatus(status));
  return () => supabase.removeChannel(channel);
}

/* ---------- Thiết bị nhận thông báo ---------- */
const PUSH_COLS = 'id';

function deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh'; }
  catch (e) { return 'Asia/Ho_Chi_Minh'; }
}

/** Lưu (hoặc làm mới) thiết bị nhận thông báo của người đang đăng nhập */
export async function savePushSubscription(subscription, ownerId) {
  const j = subscription.toJSON();
  const fields = {
    p256dh: j.keys.p256dh,
    auth_key: j.keys.auth,
    time_zone: deviceTimeZone(),
    user_agent: navigator.userAgent.slice(0, 300),
    failure_count: 0,
    last_error: null,
  };
  const found = await supabase
    .from('push_subscriptions')
    .select(PUSH_COLS)
    .eq('endpoint', j.endpoint)
    .eq('is_deleted', false)
    .limit(1);
  if (found.error) throw found.error;
  if (found.data.length) {
    const { error } = await supabase.from('push_subscriptions').update(fields).eq('id', found.data[0].id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('push_subscriptions').insert({ ...fields, owner_id: ownerId, endpoint: j.endpoint });
    if (error) throw error;
  }
}

/** Tắt nhắc việc trên thiết bị này (xoá mềm) */
export async function removePushSubscription(endpoint) {
  const { error } = await supabase
    .from('push_subscriptions')
    .update({ is_deleted: true })
    .eq('endpoint', endpoint)
    .eq('is_deleted', false);
  if (error) throw error;
}

export async function hasPushSubscription(endpoint) {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select(PUSH_COLS)
    .eq('endpoint', endpoint)
    .eq('is_deleted', false)
    .limit(1);
  if (error) throw error;
  return data.length > 0;
}
