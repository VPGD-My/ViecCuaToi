-- =====================================================================
-- Migration: 20261119000002_push_reminders
-- Nhắc việc bằng thông báo đẩy (Web Push)
--
-- Quy tắc nhắc:
--   * Việc có ngày và giờ hạn  -> nhắc trước giờ hạn một khoảng (mặc định 15 phút)
--   * Việc chỉ có ngày hạn      -> nhắc vào buổi sáng của ngày đó (mặc định 07:30)
--   * Việc không có hạn, đã xong hoặc đã xoá -> không nhắc
--
-- DATABASE DÙNG CHUNG: mọi đối tượng vẫn nằm trong schema viec_cua_toi.
-- Migration này không bật extension, không tạo cron job. Phần lịch chạy
-- nằm riêng ở supabase/cron/ vì đụng tới cài đặt dùng chung.
--
-- Rollback: supabase/rollback/20261119000002_push_reminders.down.sql
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Hàm audit dùng chung cho các bảng có xoá mềm (trừ tasks)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION viec_cua_toi.tg_set_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.owner_id   := COALESCE(v_uid, NEW.owner_id);
        NEW.created_at := now();
        NEW.created_by := COALESCE(v_uid, NEW.owner_id);
        NEW.updated_at := NULL;
        NEW.updated_by := NULL;
        NEW.is_deleted := FALSE;
        NEW.deleted_at := NULL;
        NEW.deleted_by := NULL;
    ELSE
        NEW.id         := OLD.id;
        NEW.owner_id   := OLD.owner_id;
        NEW.created_at := OLD.created_at;
        NEW.created_by := OLD.created_by;
        NEW.updated_at := now();
        NEW.updated_by := COALESCE(v_uid, OLD.owner_id);
        IF NEW.is_deleted AND NOT OLD.is_deleted THEN
            NEW.deleted_at := now();
            NEW.deleted_by := COALESCE(v_uid, OLD.owner_id);
        ELSIF NOT NEW.is_deleted THEN
            NEW.deleted_at := NULL;
            NEW.deleted_by := NULL;
        ELSE
            NEW.deleted_at := OLD.deleted_at;
            NEW.deleted_by := OLD.deleted_by;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- Thiết bị nhận thông báo (mỗi máy, mỗi người một dòng)
-- ---------------------------------------------------------------------
CREATE TABLE viec_cua_toi.push_subscriptions (
    id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id       UUID          NOT NULL REFERENCES auth.users(id),
    endpoint       VARCHAR(1000) NOT NULL CHECK (endpoint LIKE 'https://%'),
    p256dh         VARCHAR(200)  NOT NULL,
    auth_key       VARCHAR(100)  NOT NULL,
    time_zone      VARCHAR(64)   NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    user_agent     VARCHAR(300),
    failure_count  SMALLINT      NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    last_error     VARCHAR(300),
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    created_by     UUID          NOT NULL,
    updated_at     TIMESTAMPTZ,
    updated_by     UUID,
    is_deleted     BOOLEAN       NOT NULL DEFAULT FALSE,
    deleted_at     TIMESTAMPTZ,
    deleted_by     UUID,
    CONSTRAINT ck_push_subscriptions_deleted_fields
        CHECK ((is_deleted AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
            OR (NOT is_deleted AND deleted_at IS NULL AND deleted_by IS NULL))
);
COMMENT ON TABLE viec_cua_toi.push_subscriptions IS 'Thiết bị đã bật nhắc việc. Chỉ xoá mềm.';
COMMENT ON COLUMN viec_cua_toi.push_subscriptions.time_zone IS 'Múi giờ IANA của thiết bị, dùng để tính giờ nhắc';

-- Một thiết bị chỉ có một dòng còn hiệu lực cho mỗi người
CREATE UNIQUE INDEX uq_push_subscriptions_owner_endpoint
    ON viec_cua_toi.push_subscriptions (owner_id, endpoint)
    WHERE is_deleted = FALSE;
CREATE INDEX ix_push_subscriptions_owner
    ON viec_cua_toi.push_subscriptions (owner_id)
    WHERE is_deleted = FALSE;

-- Kiểm tra múi giờ hợp lệ ở tầng database
CREATE OR REPLACE FUNCTION viec_cua_toi.tg_push_subscriptions_check_tz()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone) THEN
        RAISE EXCEPTION 'Múi giờ không hợp lệ: %', NEW.time_zone USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_push_subscriptions_05_check_tz
    BEFORE INSERT OR UPDATE OF time_zone ON viec_cua_toi.push_subscriptions
    FOR EACH ROW EXECUTE FUNCTION viec_cua_toi.tg_push_subscriptions_check_tz();

CREATE TRIGGER tg_push_subscriptions_10_set_audit
    BEFORE INSERT OR UPDATE ON viec_cua_toi.push_subscriptions
    FOR EACH ROW EXECUTE FUNCTION viec_cua_toi.tg_set_audit();

-- Dùng lại hàm ghi audit_log của migration trước (hàm chung cho mọi bảng có owner_id, is_deleted)
CREATE TRIGGER tg_push_subscriptions_20_write_log
    AFTER INSERT OR UPDATE ON viec_cua_toi.push_subscriptions
    FOR EACH ROW EXECUTE FUNCTION viec_cua_toi.tg_tasks_write_log();

CREATE TRIGGER tg_push_subscriptions_block_delete
    BEFORE DELETE ON viec_cua_toi.push_subscriptions
    FOR EACH ROW EXECUTE FUNCTION viec_cua_toi.tg_block_hard_delete();

-- ---------------------------------------------------------------------
-- Nhật ký nhắc việc: mỗi lần nhắc một dòng, chống gửi trùng
-- ---------------------------------------------------------------------
CREATE TABLE viec_cua_toi.reminder_log (
    id            BIGSERIAL    PRIMARY KEY,
    task_id       UUID         NOT NULL REFERENCES viec_cua_toi.tasks(id),
    owner_id      UUID         NOT NULL REFERENCES auth.users(id),
    kind          VARCHAR(20)  NOT NULL CHECK (kind IN ('due_time', 'morning')),
    remind_at     TIMESTAMPTZ  NOT NULL,
    status        VARCHAR(20)  NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'sent', 'failed', 'no_device')),
    devices_sent  SMALLINT     NOT NULL DEFAULT 0 CHECK (devices_sent >= 0),
    detail        VARCHAR(500),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by    UUID,
    updated_at    TIMESTAMPTZ,
    updated_by    UUID,
    -- Đổi giờ hạn sẽ ra remind_at mới, nên vẫn được nhắc lại theo giờ mới
    CONSTRAINT uq_reminder_log_task_remind_at UNIQUE (task_id, remind_at)
);
COMMENT ON TABLE viec_cua_toi.reminder_log IS 'Các lần nhắc việc đã gửi. Chỉ hệ thống ghi. created_by NULL nghĩa là do bộ nhắc tự động.';
CREATE INDEX ix_reminder_log_owner ON viec_cua_toi.reminder_log (owner_id, remind_at DESC);

CREATE OR REPLACE FUNCTION viec_cua_toi.tg_reminder_log_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.id         := OLD.id;
    NEW.task_id    := OLD.task_id;
    NEW.owner_id   := OLD.owner_id;
    NEW.kind       := OLD.kind;
    NEW.remind_at  := OLD.remind_at;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.updated_at := now();
    NEW.updated_by := auth.uid();
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_reminder_log_10_touch
    BEFORE UPDATE ON viec_cua_toi.reminder_log
    FOR EACH ROW EXECUTE FUNCTION viec_cua_toi.tg_reminder_log_touch();

CREATE TRIGGER tg_reminder_log_block_delete
    BEFORE DELETE ON viec_cua_toi.reminder_log
    FOR EACH ROW EXECUTE FUNCTION viec_cua_toi.tg_block_hard_delete();

-- Index phục vụ tìm việc sắp đến hạn
CREATE INDEX ix_tasks_due_open
    ON viec_cua_toi.tasks (due_date)
    WHERE is_deleted = FALSE AND is_done = FALSE AND due_date IS NOT NULL;

-- ---------------------------------------------------------------------
-- Nhận phần việc cần nhắc (gọi bởi Edge Function, chạy định kỳ)
-- Ghi trước vào reminder_log với ON CONFLICT DO NOTHING để hai lượt chạy
-- chồng nhau không bao giờ gửi trùng.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION viec_cua_toi.claim_due_reminders(
    p_lead_minutes   INTEGER DEFAULT 15,
    p_morning        TIME    DEFAULT '07:30',
    p_window_minutes INTEGER DEFAULT 120,
    p_limit          INTEGER DEFAULT 500
)
RETURNS TABLE (
    log_id     BIGINT,
    task_id    UUID,
    owner_id   UUID,
    kind       VARCHAR,
    remind_at  TIMESTAMPTZ,
    time_zone  VARCHAR
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
BEGIN
    IF p_lead_minutes NOT BETWEEN 0 AND 1440 OR p_window_minutes NOT BETWEEN 5 AND 1440 OR p_limit NOT BETWEEN 1 AND 2000 THEN
        RAISE EXCEPTION 'Tham số không hợp lệ' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    RETURN QUERY
    WITH tz AS (
        -- Múi giờ của thiết bị bật nhắc gần nhất
        SELECT DISTINCT ON (s.owner_id) s.owner_id, s.time_zone
        FROM viec_cua_toi.push_subscriptions s
        WHERE s.is_deleted = FALSE
        ORDER BY s.owner_id, COALESCE(s.updated_at, s.created_at) DESC
    ),
    candidates AS (
        SELECT
            t.id AS c_task_id,
            t.owner_id AS c_owner_id,
            (CASE WHEN t.due_time IS NOT NULL THEN 'due_time' ELSE 'morning' END)::VARCHAR AS c_kind,
            CASE
                WHEN t.due_time IS NOT NULL
                    THEN ((t.due_date + t.due_time) AT TIME ZONE tz.time_zone) - make_interval(mins => p_lead_minutes)
                ELSE (t.due_date + p_morning) AT TIME ZONE tz.time_zone
            END AS c_remind_at,
            tz.time_zone AS c_time_zone
        FROM viec_cua_toi.tasks t
        JOIN tz ON tz.owner_id = t.owner_id
        WHERE t.is_deleted = FALSE
          AND t.is_done = FALSE
          AND t.due_date IS NOT NULL
          AND t.due_date BETWEEN (v_now - INTERVAL '2 days')::DATE AND (v_now + INTERVAL '2 days')::DATE
    ),
    due AS (
        SELECT c.*
        FROM candidates c
        WHERE c.c_remind_at <= v_now
          AND c.c_remind_at >  v_now - make_interval(mins => p_window_minutes)
        ORDER BY c.c_remind_at
        LIMIT p_limit
    ),
    claimed AS (
        INSERT INTO viec_cua_toi.reminder_log (task_id, owner_id, kind, remind_at)
        SELECT d.c_task_id, d.c_owner_id, d.c_kind, d.c_remind_at FROM due d
        ON CONFLICT ON CONSTRAINT uq_reminder_log_task_remind_at DO NOTHING
        RETURNING reminder_log.id, reminder_log.task_id, reminder_log.owner_id, reminder_log.kind, reminder_log.remind_at
    )
    SELECT cl.id, cl.task_id, cl.owner_id, cl.kind, cl.remind_at, d.c_time_zone
    FROM claimed cl
    JOIN due d ON d.c_task_id = cl.task_id AND d.c_remind_at = cl.remind_at;
END;
$$;

COMMENT ON FUNCTION viec_cua_toi.claim_due_reminders IS 'Chỉ service_role được gọi. Trả về các lần nhắc đã được nhận (claim) để Edge Function gửi.';

-- ---------------------------------------------------------------------
-- Phân quyền + RLS
-- ---------------------------------------------------------------------
REVOKE ALL ON viec_cua_toi.push_subscriptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON viec_cua_toi.reminder_log       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA viec_cua_toi FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON viec_cua_toi.push_subscriptions TO authenticated;  -- không có DELETE
GRANT SELECT                 ON viec_cua_toi.reminder_log       TO authenticated;  -- chỉ xem
GRANT ALL ON viec_cua_toi.push_subscriptions, viec_cua_toi.reminder_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE viec_cua_toi.reminder_log_id_seq TO service_role;
GRANT EXECUTE ON FUNCTION viec_cua_toi.claim_due_reminders(INTEGER, TIME, INTEGER, INTEGER) TO service_role;

ALTER TABLE viec_cua_toi.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE viec_cua_toi.reminder_log       ENABLE ROW LEVEL SECURITY;

CREATE POLICY push_subscriptions_select_own ON viec_cua_toi.push_subscriptions
    FOR SELECT TO authenticated
    USING (owner_id = (SELECT auth.uid()));

CREATE POLICY push_subscriptions_insert_own ON viec_cua_toi.push_subscriptions
    FOR INSERT TO authenticated
    WITH CHECK (owner_id = (SELECT auth.uid()));

CREATE POLICY push_subscriptions_update_own ON viec_cua_toi.push_subscriptions
    FOR UPDATE TO authenticated
    USING (owner_id = (SELECT auth.uid()))
    WITH CHECK (owner_id = (SELECT auth.uid()));

CREATE POLICY reminder_log_select_own ON viec_cua_toi.reminder_log
    FOR SELECT TO authenticated
    USING (owner_id = (SELECT auth.uid()));

COMMIT;
