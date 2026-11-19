-- =====================================================================
-- Migration: 20261114000001_init_viec_cua_toi
-- App: Việc của tôi (quản lý công việc cá nhân)
--
-- DATABASE NÀY DÙNG CHUNG VỚI PROJECT KHÁC.
-- Toàn bộ đối tượng của app nằm trong schema riêng "viec_cua_toi".
-- Migration này KHÔNG tạo, sửa hay xoá bất cứ thứ gì trong schema
-- public, auth, storage hay schema của project khác.
-- Ngoại lệ duy nhất (chỉ cộng thêm, không sửa): thêm bảng
-- viec_cua_toi.tasks vào publication supabase_realtime để đồng bộ
-- thời gian thực.
--
-- Rollback: supabase/rollback/20261114000001_init_viec_cua_toi.down.sql
-- =====================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS viec_cua_toi;
COMMENT ON SCHEMA viec_cua_toi IS 'App Việc của tôi. Không dùng chung với project khác.';

-- ---------------------------------------------------------------------
-- Bảng công việc
-- ---------------------------------------------------------------------
CREATE TABLE viec_cua_toi.tasks (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id    UUID         NOT NULL REFERENCES auth.users(id),
    space       VARCHAR(10)  NOT NULL CHECK (space IN ('work', 'home')),
    title       VARCHAR(200) NOT NULL CHECK (length(btrim(title)) > 0),
    note        VARCHAR(4000),
    due_date    DATE,
    due_time    TIME,
    priority    SMALLINT     NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
    subtasks    JSONB        NOT NULL DEFAULT '[]'::jsonb
                             CHECK (jsonb_typeof(subtasks) = 'array' AND jsonb_array_length(subtasks) <= 50),
    is_done     BOOLEAN      NOT NULL DEFAULT FALSE,
    done_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by  UUID         NOT NULL,
    updated_at  TIMESTAMPTZ,
    updated_by  UUID,
    is_deleted  BOOLEAN      NOT NULL DEFAULT FALSE,
    deleted_at  TIMESTAMPTZ,
    deleted_by  UUID,
    CONSTRAINT ck_tasks_time_needs_date CHECK (due_time IS NULL OR due_date IS NOT NULL),
    CONSTRAINT ck_tasks_done_at         CHECK ((is_done AND done_at IS NOT NULL) OR (NOT is_done AND done_at IS NULL)),
    CONSTRAINT ck_tasks_deleted_fields  CHECK ((is_deleted AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
                                            OR (NOT is_deleted AND deleted_at IS NULL AND deleted_by IS NULL))
);
COMMENT ON TABLE  viec_cua_toi.tasks          IS 'Công việc cá nhân và công việc công ty của từng người dùng. Chỉ xoá mềm.';
COMMENT ON COLUMN viec_cua_toi.tasks.space    IS 'work = Công việc, home = Cá nhân';
COMMENT ON COLUMN viec_cua_toi.tasks.priority IS '1 = Gấp (quan trọng), 2 = Bình thường, 3 = Để sau';
COMMENT ON COLUMN viec_cua_toi.tasks.subtasks IS 'Mảng các bước nhỏ: [{"text": "...", "done": false}]';

-- Truy vấn chính: việc chưa xoá của một người, theo trạng thái và hạn
CREATE INDEX ix_tasks_owner_open
    ON viec_cua_toi.tasks (owner_id, is_done, due_date)
    WHERE is_deleted = FALSE;
-- Danh sách việc đã xong mới nhất (có phân trang)
CREATE INDEX ix_tasks_owner_done_at
    ON viec_cua_toi.tasks (owner_id, done_at DESC)
    WHERE is_deleted = FALSE AND is_done = TRUE;

-- ---------------------------------------------------------------------
-- Nhật ký thay đổi (audit log)
-- ---------------------------------------------------------------------
CREATE TABLE viec_cua_toi.audit_log (
    id          BIGSERIAL    PRIMARY KEY,
    table_name  VARCHAR(63)  NOT NULL,
    record_id   UUID         NOT NULL,
    owner_id    UUID         NOT NULL,
    action      VARCHAR(20)  NOT NULL CHECK (action IN ('insert', 'update', 'soft_delete', 'restore')),
    old_data    JSONB,
    new_data    JSONB,
    changed_by  UUID         NOT NULL,
    changed_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by  UUID         NOT NULL,
    updated_at  TIMESTAMPTZ,
    updated_by  UUID
);
COMMENT ON TABLE viec_cua_toi.audit_log IS 'Lịch sử mọi thay đổi trên tasks (giá trị cũ, mới, người đổi, thời điểm). Chỉ ghi bằng trigger.';
CREATE INDEX ix_audit_log_record ON viec_cua_toi.audit_log (record_id, changed_at DESC);
CREATE INDEX ix_audit_log_owner  ON viec_cua_toi.audit_log (owner_id, changed_at DESC);

-- ---------------------------------------------------------------------
-- Trigger: tự điền cột audit, khoá các cột không được đổi
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION viec_cua_toi.tg_tasks_set_audit()
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
        -- Không cho đổi khoá, chủ sở hữu và thông tin tạo
        NEW.id         := OLD.id;
        NEW.owner_id   := OLD.owner_id;
        NEW.created_at := OLD.created_at;
        NEW.created_by := OLD.created_by;
        NEW.updated_at := now();
        NEW.updated_by := COALESCE(v_uid, OLD.owner_id);
        -- Xoá mềm / khôi phục: hệ thống tự điền thời điểm và người thực hiện
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
    -- Thời điểm hoàn thành do hệ thống quyết định
    IF NEW.is_done AND (TG_OP = 'INSERT' OR NOT OLD.is_done) THEN
        NEW.done_at := now();
    ELSIF NEW.is_done THEN
        NEW.done_at := OLD.done_at;
    ELSE
        NEW.done_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_tasks_10_set_audit
    BEFORE INSERT OR UPDATE ON viec_cua_toi.tasks
    FOR EACH ROW EXECUTE FUNCTION viec_cua_toi.tg_tasks_set_audit();

-- ---------------------------------------------------------------------
-- Trigger: ghi audit log (giá trị cũ, giá trị mới, người đổi, thời điểm)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION viec_cua_toi.tg_tasks_write_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_action VARCHAR(20);
    v_uid    UUID := COALESCE(auth.uid(), NEW.owner_id);
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_action := 'insert';
    ELSIF NEW.is_deleted AND NOT OLD.is_deleted THEN
        v_action := 'soft_delete';
    ELSIF OLD.is_deleted AND NOT NEW.is_deleted THEN
        v_action := 'restore';
    ELSE
        v_action := 'update';
    END IF;

    INSERT INTO viec_cua_toi.audit_log
        (table_name, record_id, owner_id, action, old_data, new_data, changed_by, created_by)
    VALUES
        (TG_TABLE_NAME, NEW.id, NEW.owner_id, v_action,
         CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
         to_jsonb(NEW),
         v_uid,
         v_uid);
    RETURN NULL;
END;
$$;

CREATE TRIGGER tg_tasks_20_write_log
    AFTER INSERT OR UPDATE ON viec_cua_toi.tasks
    FOR EACH ROW EXECUTE FUNCTION viec_cua_toi.tg_tasks_write_log();

-- ---------------------------------------------------------------------
-- Chặn xoá cứng (kể cả khi lỡ cấp quyền DELETE sau này)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION viec_cua_toi.tg_block_hard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'Không được xoá cứng trên %.%: hãy dùng is_deleted = TRUE', TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER tg_tasks_block_delete
    BEFORE DELETE ON viec_cua_toi.tasks
    FOR EACH ROW EXECUTE FUNCTION viec_cua_toi.tg_block_hard_delete();

CREATE TRIGGER tg_audit_log_block_delete
    BEFORE DELETE ON viec_cua_toi.audit_log
    FOR EACH ROW EXECUTE FUNCTION viec_cua_toi.tg_block_hard_delete();

-- ---------------------------------------------------------------------
-- Phân quyền tối thiểu + Row Level Security
-- ---------------------------------------------------------------------
REVOKE ALL ON SCHEMA viec_cua_toi FROM PUBLIC;
REVOKE ALL ON ALL TABLES    IN SCHEMA viec_cua_toi FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA viec_cua_toi FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA viec_cua_toi FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA viec_cua_toi TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON viec_cua_toi.tasks     TO authenticated;  -- không có DELETE
GRANT SELECT                 ON viec_cua_toi.audit_log TO authenticated;  -- chỉ đọc nhật ký của chính mình
GRANT ALL ON ALL TABLES    IN SCHEMA viec_cua_toi TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA viec_cua_toi TO service_role;

ALTER TABLE viec_cua_toi.tasks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE viec_cua_toi.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tasks_select_own ON viec_cua_toi.tasks
    FOR SELECT TO authenticated
    USING (owner_id = (SELECT auth.uid()));

CREATE POLICY tasks_insert_own ON viec_cua_toi.tasks
    FOR INSERT TO authenticated
    WITH CHECK (owner_id = (SELECT auth.uid()));

CREATE POLICY tasks_update_own ON viec_cua_toi.tasks
    FOR UPDATE TO authenticated
    USING (owner_id = (SELECT auth.uid()))
    WITH CHECK (owner_id = (SELECT auth.uid()));

CREATE POLICY audit_log_select_own ON viec_cua_toi.audit_log
    FOR SELECT TO authenticated
    USING (owner_id = (SELECT auth.uid()));

-- ---------------------------------------------------------------------
-- Realtime: chỉ cộng thêm bảng của app vào publication có sẵn
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
       AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                       WHERE pubname = 'supabase_realtime'
                         AND schemaname = 'viec_cua_toi' AND tablename = 'tasks') THEN
        EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE viec_cua_toi.tasks';
    END IF;
END;
$$;

COMMIT;
