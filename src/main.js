import './style.css';
import { configured, supabase, fetchTasks, fromRow, saveTask, softDeleteTasks, subscribeTasks, savePushSubscription, removePushSubscription, hasPushSubscription } from './store.js';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || '';
const VAPID_KEY = VAPID_PUBLIC_KEY.replace(/[\s"']/g, '');
const REMIND_BEFORE_MIN = import.meta.env.VITE_REMIND_BEFORE_MIN || '15';
const MORNING_TIME = import.meta.env.VITE_MORNING_TIME || '07:30';
(function(){
    const LS_UI = "viec-cua-toi:ui";
  const $ = s => document.querySelector(s);
  let tasks = [];
  let ui = {space:"work", showDone:false, theme:"auto"};
  try{ Object.assign(ui, JSON.parse(localStorage.getItem(LS_UI)||"{}")); }catch(e){}
  let query = "";
  let editing = null; // draft object

  /* ---------- dates ---------- */
  const pad = n => String(n).padStart(2,"0");
  const iso = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
  const addDays = (d,n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
  const todayIso = () => iso(new Date());
  const WD = ["Chủ nhật","Thứ Hai","Thứ Ba","Thứ Tư","Thứ Năm","Thứ Sáu","Thứ Bảy"];
  function parseIso(s){ const [y,m,d]=s.split("-").map(Number); return new Date(y,m-1,d); }
  function dayDiff(s){ return Math.round((parseIso(s) - parseIso(todayIso()))/86400000); }
  function dueLabel(t){
    if(!t.due) return "";
    const d = dayDiff(t.due);
    let s;
    if(d===0) s="Hôm nay"; else if(d===1) s="Ngày mai"; else if(d===-1) s="Hôm qua";
    else if(d<0) s=(-d)+" ngày trước";
    else if(d<7) s=WD[parseIso(t.due).getDay()];
    else { const x=parseIso(t.due); s=x.getDate()+"/"+(x.getMonth()+1); }
    return t.time ? s+", "+t.time : s;
  }
  const THEMES = {
    auto:{label:"Theo máy", icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M11 18.5h2"/></svg>'},
    light:{label:"Sáng", icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>'},
    dark:{label:"Tối", icon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>'}
  };
  function applyTheme(){
    const t = THEMES[ui.theme] ? ui.theme : "auto";
    if(t==="auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    $("#themeIcon").innerHTML = THEMES[t].icon;
    $("#themeLabel").textContent = THEMES[t].label;
    $("#themeBtn").setAttribute("aria-label", "Giao diện: "+THEMES[t].label+". Chạm để đổi");
    $("#themeBtn").title = "Giao diện: "+THEMES[t].label;
    const m = document.querySelector('meta[name="theme-color"]');
    if(m) m.setAttribute("content", getComputedStyle(document.body).backgroundColor);
  }
  function scrollToTop(){
    const sc = $("#scroller");
    if(sc && getComputedStyle(sc).display!=="contents" && sc.scrollHeight>sc.clientHeight) sc.scrollTo({top:0,behavior:"smooth"});
    else window.scrollTo({top:0,behavior:"smooth"});
  }
  function tickClock(){
    const n = new Date(); const el = $("#sbTime");
    if(el) el.textContent = n.getHours()+":"+String(n.getMinutes()).padStart(2,"0");
  }
  function renderDots(all, done){
    const box = $("#dots"); const n = all.length; const max = 8;
    let h = "";
    for(let i=0;i<Math.min(n,max);i++) h += '<i class="'+(i<done?"on":"")+'"></i>';
    if(n>max) h += '<em>+'+(n-max)+'</em>';
    if(!n) h = '<em>Chưa có việc nào cho hôm nay</em>';
    box.innerHTML = h;
    $("#progText").textContent = n ? done+"/"+n+" xong" : "";
  }
  function renderDate(){
    const n = new Date(); const h = n.getHours();
    $("#dateSmall").textContent = WD[n.getDay()]+", "+n.getDate()+" tháng "+(n.getMonth()+1);
    $("#greet").textContent = h<11 ? "Chào buổi sáng" : h<14 ? "Chào buổi trưa" : h<18 ? "Chào buổi chiều" : "Chào buổi tối";
  }

  /* ---------- storage (Supabase) ---------- */
  let userId = null;
  let unsubscribe = null;

  const cacheKey = () => "viec-cua-toi:cache:" + userId;

  function loadLocal(){
    if(!userId) return;
    try{ const v = JSON.parse(localStorage.getItem(cacheKey())||"[]"); if(Array.isArray(v)) tasks = v; }catch(e){ tasks = []; }
  }
  function saveLocal(){ if(!userId) return; try{ localStorage.setItem(cacheKey(), JSON.stringify(tasks)); }catch(e){} }
  function saveUi(){ try{ localStorage.setItem(LS_UI, JSON.stringify(ui)); }catch(e){} }
  function setSync(msg){ $("#syncNote").textContent = msg || ""; }

  function errText(e){
    const m = (e && (e.message || e.error_description)) || "";
    if(/fetch|network|Failed/i.test(m)) return "Chưa kết nối được máy chủ. Kiểm tra mạng rồi thử lại.";
    if(/JWT|token|session/i.test(m)) return "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.";
    return "Chưa lưu được. Thử lại sau nhé.";
  }

  async function persist(task){
    saveLocal();
    try{
      const saved = await saveTask(task, userId);
      tasks = tasks.map(x => x.id===saved.id ? Object.assign({}, x, saved) : x);
      saveLocal();
    }catch(e){ console.error(e); toast(errText(e)); }
  }
  async function removeStored(id){ return removeMany([id]); }
  async function removeMany(ids){
    saveLocal();
    try{ await softDeleteTasks(ids); }
    catch(e){ console.error(e); toast(errText(e)); }
  }

  function applyRemoteRow(row){
    if(row.is_deleted) tasks = tasks.filter(t => t.id !== row.id);
    else {
      const t = fromRow(row);
      tasks = tasks.some(x => x.id===t.id) ? tasks.map(x => x.id===t.id ? t : x) : tasks.concat(t);
    }
    saveLocal();
    if(!editing) render();
  }

  async function refresh(){
    try{
      tasks = await fetchTasks();
      saveLocal(); render();
      setSync("Đã đồng bộ. Chỉ bạn xem được danh sách này.");
    }catch(e){
      console.error(e);
      setSync("Chưa tải được dữ liệu mới, đang hiện bản lưu trên máy.");
    }
  }

  async function startSession(user){
    if(userId === user.id) return;
    userId = user.id;
    hideAuth();
    tasks = []; loadLocal(); render();
    setSync("Đang đồng bộ…");
    await refresh();
    openFromUrl(location.hash);
    initPush();
    if(unsubscribe) unsubscribe();
    unsubscribe = subscribeTasks(userId, applyRemoteRow, status => {
      if(status === "CHANNEL_ERROR" || status === "TIMED_OUT") setSync("Mất kết nối thời gian thực, sẽ tải lại khi bạn quay lại app.");
    });
  }
  function endSession(){
    if(unsubscribe){ unsubscribe(); unsubscribe = null; }
    userId = null; tasks = []; pushOn = false; render(); renderBell();
    showAuth("login");
  }

  /* ---------- auth screen ---------- */
  let authMode = "login";
  function showAuth(m){
    authMode = m; $("#auth").hidden = false;
    const map = {
      login:{sub:"Đăng nhập để xem danh sách việc của bạn", btn:"Đăng nhập", sw:"Chưa có tài khoản? Đăng ký", pass:true, email:true, ac:"current-password"},
      signup:{sub:"Tạo tài khoản mới, mật khẩu từ 8 ký tự", btn:"Đăng ký", sw:"Đã có tài khoản? Đăng nhập", pass:true, email:true, ac:"new-password"},
      forgot:{sub:"Nhập email, mình sẽ gửi link đặt lại mật khẩu", btn:"Gửi link", sw:"Quay lại đăng nhập", pass:false, email:true},
      reset:{sub:"Đặt mật khẩu mới cho tài khoản của bạn", btn:"Lưu mật khẩu", sw:"Quay lại đăng nhập", pass:true, email:false, ac:"new-password"},
      config:{sub:"App chưa được cấu hình Supabase. Xem README để điền VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY.", btn:"", sw:"", pass:false, email:false}
    }[m];
    $("#authSub").textContent = map.sub;
    $("#authSubmit").textContent = map.btn; $("#authSubmit").hidden = !map.btn;
    $("#authSwitch").textContent = map.sw; $("#authSwitch").hidden = !map.sw;
    $("#authForgot").hidden = m!=="login";
    $("#passRow").hidden = !map.pass; $("#emailRow").hidden = !map.email;
    if(map.ac) $("#authPass").setAttribute("autocomplete", map.ac);
    $("#authPass").value = "";
    authMsg("");
  }
  function hideAuth(){ $("#auth").hidden = true; }
  function authMsg(t, err){ const el=$("#authMsg"); el.textContent=t; el.classList.toggle("err", !!err); }
  function authErr(e){
    const m = (e && e.message) || "";
    if(/Invalid login/i.test(m)) return "Email hoặc mật khẩu chưa đúng.";
    if(/Email not confirmed/i.test(m)) return "Email chưa được xác nhận. Kiểm tra hộp thư của bạn.";
    if(/already registered/i.test(m)) return "Email này đã có tài khoản, hãy đăng nhập.";
    if(/Password should be/i.test(m)) return "Mật khẩu cần ít nhất 8 ký tự.";
    if(/rate limit/i.test(m)) return "Bạn thao tác hơi nhanh, đợi một lát rồi thử lại nhé.";
    return m || "Có lỗi xảy ra, thử lại sau nhé.";
  }
  const redirectUrl = () => location.origin + location.pathname;

  $("#authSwitch").onclick = ()=> showAuth(authMode==="login" ? "signup" : "login");
  $("#authForgot").onclick = ()=> showAuth("forgot");
  $("#authForm").onsubmit = async (e)=>{
    e.preventDefault();
    const email = $("#authEmail").value.trim(), pass = $("#authPass").value;
    const btn = $("#authSubmit"); btn.disabled = true; authMsg("Đang xử lý…");
    try{
      if(authMode==="login"){
        const { error } = await supabase.auth.signInWithPassword({ email, password: pass }); if(error) throw error;
      } else if(authMode==="signup"){
        if(pass.length < 8) throw { message:"Password should be at least 8" };
        const { data, error } = await supabase.auth.signUp({ email, password: pass, options:{ emailRedirectTo: redirectUrl() } }); if(error) throw error;
        if(!data.session) authMsg("Đã gửi email xác nhận. Mở link trong email rồi quay lại đăng nhập nhé.");
      } else if(authMode==="forgot"){
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() }); if(error) throw error;
        authMsg("Nếu email có tài khoản, link đặt lại mật khẩu đã được gửi.");
      } else if(authMode==="reset"){
        if(pass.length < 8) throw { message:"Password should be at least 8" };
        const { data, error } = await supabase.auth.updateUser({ password: pass }); if(error) throw error;
        authMsg("Đã đổi mật khẩu."); if(data.user) startSession(data.user);
      }
    }catch(err){ authMsg(authErr(err), true); }
    finally{ btn.disabled = false; }
  };
  $("#logoutBtn").onclick = async ()=>{ if(pushOn) await disablePush(true); try{ await supabase.auth.signOut(); }catch(e){} endSession(); };

  /* ---------- nhắc việc (Web Push) ---------- */
  const BELL_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
  const BELL_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 9.3-5"/><path d="M18 8c0 7 3 9 3 9H9"/><path d="M6 8c0 7-3 9-3 9h3"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>';
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let swReg = null;
  let pushOn = false;
  const HINT_KEY = "viec-cua-toi:push-hint-later";

  function remindRuleText(){
    const lead = Number(REMIND_BEFORE_MIN);
    const a = lead > 0 ? "Việc có giờ sẽ được nhắc trước "+lead+" phút" : "Việc có giờ sẽ được nhắc đúng giờ";
    return a+", việc chỉ có ngày được nhắc lúc "+MORNING_TIME.replace(/^0/,"")+" sáng.";
  }
  function b64ToUint8(b64){
    const pad = "=".repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }
  async function registerSW(){
    if(!("serviceWorker" in navigator)) return null;
    try{ swReg = await navigator.serviceWorker.register("./sw.js", { scope: "./" }); await navigator.serviceWorker.ready; }
    catch(e){ console.error(e); swReg = null; }
    return swReg;
  }
  function renderBell(){
    const btn = $("#bellBtn");
    if(!VAPID_PUBLIC_KEY || !userId){ btn.hidden = true; $("#pushHint").hidden = true; return; }
    btn.hidden = false;
    btn.classList.toggle("on", pushOn);
    $("#bellIcon").innerHTML = pushOn ? BELL_ON : BELL_OFF;
    const label = pushOn ? "Đang bật nhắc việc. Chạm để tắt" : "Bật nhắc việc";
    btn.setAttribute("aria-label", label); btn.title = label;
    let later = false; try{ later = localStorage.getItem(HINT_KEY) === "1"; }catch(e){}
    const canAsk = pushSupported && Notification.permission !== "denied";
    const iosNeedsInstall = isIOS && !isStandalone() && !pushSupported;
    $("#pushHint").hidden = pushOn || later || !(canAsk || iosNeedsInstall);
    $("#pushHintText").textContent = iosNeedsInstall
      ? "Thêm app vào màn hình chính (Chia sẻ, Thêm vào MH chính) để nhận nhắc việc"
      : "Bật nhắc việc để mèo báo bạn khi đến hạn";
    $("#pushHintOn").hidden = iosNeedsInstall;
  }
  async function initPush(){
    pushOn = false;
    if(VAPID_PUBLIC_KEY && pushSupported){
      await registerSW();
      try{
        const sub = swReg && await swReg.pushManager.getSubscription();
        if(sub && Notification.permission === "granted"){
          pushOn = await hasPushSubscription(sub.endpoint);
          // Máy đã đăng ký nhưng tài khoản này chưa có: chưa bật cho tài khoản này
          if(pushOn) await savePushSubscription(sub, userId); // làm mới khoá và múi giờ
        }
      }catch(e){ console.error(e); }
    }
    renderBell();
  }
  async function enablePush(){
    if(!pushSupported){
      toast(isIOS && !isStandalone() ? "Hãy thêm app vào màn hình chính rồi mở từ đó để bật nhắc việc." : "Trình duyệt này chưa hỗ trợ nhắc việc.");
      return;
    }
    if(Notification.permission === "denied"){
      toast("Bạn đã chặn thông báo. Vào Cài đặt điện thoại, mục Thông báo, cho phép lại nhé.");
      return;
    }
    const perm = await Notification.requestPermission();
    if(perm !== "granted"){ toast("Chưa bật nhắc việc vì chưa được cho phép thông báo."); renderBell(); return; }
    let step = "sw";
    try{
      const reg = swReg || await registerSW();
      if(!reg) throw new Error("Không đăng ký được service worker");
      step = "key";
      const key = b64ToUint8(VAPID_KEY);
      if(key.length !== 65 || key[0] !== 4) throw new Error("Khoá VAPID public không hợp lệ (độ dài "+key.length+")");
      step = "subscribe";
      let sub = await reg.pushManager.getSubscription();
      // Máy từng đăng ký bằng khoá cũ: huỷ rồi đăng ký lại bằng khoá hiện tại
      if(sub && sub.options && sub.options.applicationServerKey){
        const cur = new Uint8Array(sub.options.applicationServerKey);
        if(cur.length !== key.length || cur.some((b,i)=>b!==key[i])){ await sub.unsubscribe(); sub = null; }
      }
      if(!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      step = "save";
      await savePushSubscription(sub, userId);
      pushOn = true; renderBell();
      toast("Đã bật nhắc việc. "+remindRuleText());
    }catch(e){
      console.error(e);
      const where = { sw:"bước 1 (service worker)", key:"bước 2 (khoá VAPID)", subscribe:"bước 3 (đăng ký với điện thoại)", save:"bước 4 (lưu lên Supabase)" }[step];
      const detail = (e && (e.message || e.code || e.name)) ? String(e.message || e.code || e.name).slice(0,140) : "";
      toast("Chưa bật được nhắc việc, lỗi ở "+where+(detail ? ": "+detail : ""), null, 12000);
    }
  }
  async function disablePush(silent){
    try{
      const sub = swReg && await swReg.pushManager.getSubscription();
      if(sub){ await removePushSubscription(sub.endpoint); await sub.unsubscribe(); }
    }catch(e){ console.error(e); }
    pushOn = false; renderBell();
    if(!silent) toast("Đã tắt nhắc việc trên máy này.");
  }
  $("#bellBtn").onclick = ()=> pushOn ? disablePush(false) : enablePush();
  $("#pushHintOn").onclick = enablePush;
  $("#pushHintLater").onclick = ()=>{ try{ localStorage.setItem(HINT_KEY,"1"); }catch(e){} renderBell(); };

  // Chạm vào thông báo: mở đúng việc
  function openFromUrl(url){
    const m = /#task-([0-9a-f-]{36})/.exec(url || location.hash);
    if(!m) return;
    const t = findTask(m[1]);
    if(t){ openSheet(t); history.replaceState(null, "", location.pathname + location.search); }
  }
  if("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", e=>{
    if(e.data && e.data.type === "open-task") openFromUrl(e.data.url);
  });

  async function boot(){
    if(!configured){ showAuth("config"); return; }
    supabase.auth.onAuthStateChange((event, session)=>{
      if(event === "PASSWORD_RECOVERY"){ showAuth("reset"); return; }
      if(event === "SIGNED_OUT"){ if(userId) endSession(); return; }
      if(session && session.user && authMode !== "reset") setTimeout(()=>startSession(session.user), 0);
    });
    const { data } = await supabase.auth.getSession();
    if(data.session && data.session.user) startSession(data.session.user);
    else if(authMode !== "reset") showAuth("login");
  }

  /* ---------- render ---------- */
  const CAT_LATE = '<svg aria-hidden="true"  viewBox="0 0 100 108" class="pcat"><path d="M64 72 C70 84 62 94 70 100" fill="none" stroke="#F5B9C6" stroke-width="7" stroke-linecap="round" filter="url(#pr1f)"></path><path d="M66 82 l5 -1 M65 90 l5 1" stroke="#E08398" stroke-width="2.4" stroke-linecap="round" opacity=".55"></path><g filter="url(#pr1f)"><path d="M24 24 L27 2 L42 13 Z" fill="#F5B9C6"></path><path d="M76 24 L73 2 L58 13 Z" fill="#F5B9C6"></path><circle cx="50" cy="44" r="36" fill="url(#pr1g)"></circle></g><path d="M29 20 L30 9 L37 15 Z M71 20 L70 9 L63 15 Z" fill="#F4B6C2" opacity=".75"></path><path d="M46 10 l1 6 M50 9 v6 M54 10 l-1 6" stroke="#E08398" stroke-width="2.2" stroke-linecap="round" opacity=".5"></path><path d="M15 32 q6 3 0 6 M85 32 q-6 3 0 6" fill="none" stroke="#E08398" stroke-width="2" opacity=".35"></path><circle cx="40" cy="36" r="3.2" fill="#3E3446"></circle><circle cx="60" cy="36" r="3.2" fill="#3E3446"></circle><circle cx="41" cy="35" r="1" fill="#FFFFFF"></circle><circle cx="61" cy="35" r="1" fill="#FFFFFF"></circle><ellipse cx="33" cy="42" rx="5.5" ry="3" fill="#F29BAF" opacity=".55"></ellipse><ellipse cx="67" cy="42" rx="5.5" ry="3" fill="#F29BAF" opacity=".55"></ellipse><path d="M48.6 40 h2.8 l-1.4 1.6 Z" fill="#D7838F"></path><ellipse cx="50" cy="45" rx="2.2" ry="2.8" fill="#3E3446"></ellipse><path d="M34 27 L44 24 M66 27 L56 24" stroke="#3E3446" stroke-width="2" stroke-linecap="round"></path><path d="M80 16 q-5 7 0 9 q5 -2 0 -9 Z" fill="#9FC8F0" stroke="#6E9FD0" stroke-width="1"></path><path d="M30 39 L14 36 M30 43 L15 44 M70 39 L86 36 M70 43 L85 44" stroke="#8C8296" stroke-width=".8" stroke-linecap="round"></path><ellipse cx="36" cy="74" rx="7" ry="4.5" fill="#FDE3E9"></ellipse><ellipse cx="60" cy="74" rx="7" ry="4.5" fill="#FDE3E9"></ellipse></svg>';
  const CAT_IMP = '<svg aria-hidden="true"  viewBox="0 0 100 108" class="pcat"><path d="M64 72 C70 84 62 94 70 100" fill="none" stroke="#F2D27A" stroke-width="7" stroke-linecap="round" filter="url(#pr2f)"></path><path d="M66 82 l5 -1 M65 90 l5 1" stroke="#D4A43E" stroke-width="2.4" stroke-linecap="round" opacity=".55"></path><g filter="url(#pr2f)"><path d="M24 24 L27 2 L42 13 Z" fill="#F2D27A"></path><path d="M76 24 L73 2 L58 13 Z" fill="#F2D27A"></path><circle cx="50" cy="44" r="36" fill="url(#pr2g)"></circle></g><path d="M29 20 L30 9 L37 15 Z M71 20 L70 9 L63 15 Z" fill="#F4B6C2" opacity=".75"></path><path d="M46 10 l1 6 M50 9 v6 M54 10 l-1 6" stroke="#D4A43E" stroke-width="2.2" stroke-linecap="round" opacity=".5"></path><path d="M15 32 q6 3 0 6 M85 32 q-6 3 0 6" fill="none" stroke="#D4A43E" stroke-width="2" opacity=".35"></path><path d="M35 38 L40 32.5 L45 38 M55 38 L60 32.5 L65 38" fill="none" stroke="#3E3446" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path><ellipse cx="33" cy="42" rx="5.5" ry="3" fill="#F29BAF" opacity=".55"></ellipse><ellipse cx="67" cy="42" rx="5.5" ry="3" fill="#F29BAF" opacity=".55"></ellipse><path d="M48.6 40 h2.8 l-1.4 1.6 Z" fill="#D7838F"></path><path d="M45.5 43 Q50 49 54.5 43 Z" fill="#C2566C" stroke="#3E3446" stroke-width="1.1" stroke-linejoin="round"></path><path d="M30 39 L14 36 M30 43 L15 44 M70 39 L86 36 M70 43 L85 44" stroke="#8C8296" stroke-width=".8" stroke-linecap="round"></path><ellipse cx="36" cy="74" rx="7" ry="4.5" fill="#FCF0C8"></ellipse><ellipse cx="60" cy="74" rx="7" ry="4.5" fill="#FCF0C8"></ellipse></svg>';
  const IMP_ICON = '<svg viewBox="0 0 16 14" aria-hidden="true"><path d="M2 6 L3 0.8 L6.5 3.5 Z M14 6 L13 0.8 L9.5 3.5 Z" fill="#E7798F"></path><circle cx="8" cy="8" r="5.6" fill="#E7798F"></circle><path d="M5 7.6 Q6 8.6 7 7.6 M9 7.6 Q10 8.6 11 7.6" fill="none" stroke="#FFFFFF" stroke-width="1.1" stroke-linecap="round"></path></svg>';
  const PETAL = '<svg class="petal" viewBox="0 0 12 12" aria-hidden="true"><ellipse cx="6" cy="6" rx="5" ry="3.6" fill="currentColor" opacity=".55" transform="rotate(-30 6 6)"></ellipse></svg>';
  const icons = {
    check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7.5"/></svg>',
    clock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    list:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    note:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5h14M5 10h14M5 15h9"/></svg>'
  };
  const esc = s => String(s||"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

  function sortTasks(a,b){
    const ad = a.due||"9999-99-99", bd = b.due||"9999-99-99";
    if(ad!==bd) return ad<bd?-1:1;
    const at = a.time||"99:99", bt = b.time||"99:99";
    if(at!==bt) return at<bt?-1:1;
    if((a.priority||2)!==(b.priority||2)) return (a.priority||2)-(b.priority||2);
    return (a.createdAt||0)-(b.createdAt||0);
  }

  function inSpace(t){ return ui.space==="all" || t.space===ui.space; }
  function matches(t){
    if(!query) return true;
    const q = query.toLowerCase();
    return (t.title||"").toLowerCase().includes(q) || (t.note||"").toLowerCase().includes(q);
  }

  function taskHtml(t){
    const late = t.due && !t.done && dayDiff(t.due)<0;
    const subs = t.subtasks||[];
    const subDone = subs.filter(s=>s.done).length;
    let meta = [];
    if(ui.space==="all") meta.push('<span class="tag">'+(t.space==="work"?"Công việc":"Cá nhân")+'</span>');
    const imp = t.priority===1 && !t.done;
    if(imp) meta.push('<span class="imp">'+IMP_ICON+'Quan trọng</span>');
    if(t.due) meta.push('<span class="'+(late?"late":"")+'">'+icons.clock+esc(dueLabel(t))+'</span>');
    if(subs.length) meta.push('<span>'+icons.list+subDone+'/'+subs.length+'</span>');
    if(t.note) meta.push('<span>'+icons.note+'Có ghi chú</span>');
    return '<div class="task space-'+t.space+(t.done?" done":"")+(imp?" prio":"")+'" data-id="'+esc(t.id)+'">'+
      (imp ? (late ? CAT_LATE : CAT_IMP) : '')+
      '<button class="check" data-act="toggle" aria-label="'+(t.done?"Bỏ đánh dấu xong":"Đánh dấu xong")+': '+esc(t.title)+'">'+icons.check+'</button>'+
      '<button class="body" data-act="open"><div class="title">'+esc(t.title)+'</div>'+
      (meta.length?'<div class="meta">'+meta.join("")+'</div>':'')+'</button></div>';
  }

  function render(){
    document.body.dataset.space = ui.space;
    document.querySelectorAll("[data-s]").forEach(b=>b.setAttribute("aria-pressed", String(b.dataset.s===ui.space)));
    const openWork = tasks.filter(t=>t.space==="work" && !t.done).length;
    const openHome = tasks.filter(t=>t.space==="home" && !t.done).length;
    $("#nWork").textContent = openWork; $("#nHome").textContent = openHome;

    const scoped = tasks.filter(inSpace);
    const t0 = todayIso();
    const open = scoped.filter(t=>!t.done);
    const lateN = open.filter(t=>t.due && t.due<t0).length;
    const todayAll = scoped.filter(t=>t.due===t0 || (t.done && t.doneOn===t0) || (!t.done && t.due && t.due<t0));
    const todayDone = todayAll.filter(t=>t.done).length;
    const pct = todayAll.length ? Math.round(todayDone/todayAll.length*100) : 0;
    renderDots(todayAll, todayDone);
    const nameMap = {work:"việc công ty", home:"việc cá nhân", all:"việc"};
    if(!open.length) $("#summary").innerHTML = scoped.length ? "Bạn đã xong hết "+nameMap[ui.space]+". Nghỉ một chút nhé." : "Chưa có "+nameMap[ui.space]+" nào.";
    else {
      const todayOpen = open.filter(t=>t.due===t0).length;
      let s = todayOpen ? "Còn "+todayOpen+" "+nameMap[ui.space]+" hôm nay" : "Hôm nay thảnh thơi, còn "+open.length+" "+nameMap[ui.space]+" phía trước";
      if(lateN) s += ', <span class="late">'+lateN+" việc quá hạn</span>";
      s += todayOpen ? ", cứ từ từ nhé." : ".";
      $("#summary").innerHTML = s;
    }

    const list = open.filter(matches).sort(sortTasks);
    const tomorrow = iso(addDays(new Date(),1));
    const weekEnd = iso(addDays(new Date(),7));
    const groups = [
      {k:"overdue", name:"Quá hạn", f:t=>t.due && t.due<t0},
      {k:"today", name:"Hôm nay", f:t=>t.due===t0},
      {k:"tomorrow", name:"Ngày mai", f:t=>t.due===tomorrow},
      {k:"week", name:"7 ngày tới", f:t=>t.due>tomorrow && t.due<=weekEnd},
      {k:"later", name:"Sau đó", f:t=>t.due>weekEnd},
      {k:"none", name:"Chưa có hạn", f:t=>!t.due}
    ];
    let html = "";
    for(const g of groups){
      const items = list.filter(g.f);
      if(!items.length) continue;
      if(g.k==="none") items.sort((a,b)=>(a.priority||2)-(b.priority||2) || (a.createdAt||0)-(b.createdAt||0));
      html += '<section class="group '+g.k+'"><h2>'+PETAL+g.name+' <span class="c">'+items.length+'</span></h2><div class="list">'+items.map(taskHtml).join("")+'</div></section>';
    }
    const doneList = scoped.filter(t=>t.done && matches(t)).sort((a,b)=>(b.doneAt||0)-(a.doneAt||0));
    if(!html && !doneList.length){
      if(query) html = '<div class="empty"><div class="big">Không thấy việc nào khớp</div>Thử tìm bằng từ khác.</div>';
      else html = '<div class="empty"><div class="big">'+(ui.space==="home"?"Danh sách cá nhân đang trống":ui.space==="work"?"Danh sách công việc đang trống":"Chưa có việc nào")+'</div>Ghi lại việc đầu tiên để bắt đầu.<br><button class="btn ghost" data-act="new">Thêm việc đầu tiên</button></div>';
    } else if(!html && !query){
      html = '<div class="empty"><div class="big">Xong hết rồi</div>Không còn việc nào đang chờ ở đây.</div>';
    }
    if(doneList.length){
      html += '<button class="done-toggle" data-act="toggleDone">'+(ui.showDone?"Ẩn":"Hiện")+' '+doneList.length+' việc đã xong</button>';
      if(ui.showDone){
        html += '<section class="group"><h2>'+PETAL+'Đã xong</h2><div class="list">'+doneList.slice(0,100).map(taskHtml).join("")+'</div></section>';
        html += '<button class="done-toggle" data-act="clearDone" style="margin-top:10px">Xoá các việc đã xong</button>';
      }
    }
    $("#main").innerHTML = html;
  }

  /* ---------- actions ---------- */
  function uid(){ return crypto.randomUUID(); }
  function findTask(id){ return tasks.find(t=>t.id===id); }

  async function toggleTask(id){
    const t = findTask(id); if(!t) return;
    const updated = Object.assign({}, t, {done:!t.done, doneAt:!t.done?Date.now():null, doneOn:!t.done?todayIso():null});
    tasks = tasks.map(x=>x.id===id?updated:x);
    render();
    if(updated.done) toast("Đã xong: "+updated.title, ()=>toggleTask(id));
    await persist(updated);
  }

  let toastTimer;
  function toast(msg, undo, ms){
    $("#toastMsg").textContent = msg;
    const u = $("#toastUndo");
    u.hidden = !undo;
    u.onclick = ()=>{ $("#toast").classList.remove("on"); undo && undo(); };
    $("#toast").classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>$("#toast").classList.remove("on"), ms || 3800);
  }

  /* ---------- sheet ---------- */
  function openSheet(task){
    const def = ui.space==="all" ? "work" : ui.space;
    editing = task ? JSON.parse(JSON.stringify(task)) : {id:null, title:"", note:"", space:def, due:"", time:"", priority:2, subtasks:[], done:false};
    $("#sheetTitle").textContent = task ? "Sửa việc" : "Việc mới";
    $("#fTitle").value = editing.title;
    $("#fTitleErr").hidden = true;
    $("#fNote").value = editing.note||"";
    $("#fDate").value = editing.due||"";
    $("#fTime").value = editing.time||"";
    $("#delBtn").hidden = !task;
    $("#saveBtn").textContent = task ? "Lưu thay đổi" : "Lưu việc";
    syncSheet();
    renderSubs();
    lockPage(true);
    $("#scrim").classList.add("on");
    $("#sheet").classList.add("on");
    // Trên điện thoại không tự bật bàn phím, tránh bảng bị đẩy lên xuống
    if(!task && !window.matchMedia("(pointer: coarse)").matches) setTimeout(()=>$("#fTitle").focus(), 220);
  }
  let lockedY = 0;
  function lockPage(on){
    const framed = getComputedStyle($("#scroller")).display !== "contents";
    const root = document.documentElement, body = document.body;
    if(on){
      root.classList.add("sheet-open");
      if(!framed){ lockedY = window.scrollY; body.classList.add("lock"); body.style.top = (-lockedY)+"px"; }
    } else {
      root.classList.remove("sheet-open");
      if(body.classList.contains("lock")){ body.classList.remove("lock"); body.style.top = ""; window.scrollTo(0, lockedY); }
    }
  }
  // iPhone: khi bàn phím bật, giữ bảng nằm ngay trên bàn phím thay vì để trang trôi
  function fitSheetToKeyboard(){
    const vv = window.visualViewport, sh = $("#sheet");
    if(!vv || !sh.classList.contains("on") || getComputedStyle($("#scroller")).display !== "contents"){ sh.style.bottom = ""; sh.style.maxHeight = ""; return; }
    const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    sh.style.bottom = hidden + "px";
    sh.style.maxHeight = Math.round(vv.height * 0.92) + "px";
  }
  if(window.visualViewport){
    window.visualViewport.addEventListener("resize", fitSheetToKeyboard);
    window.visualViewport.addEventListener("scroll", fitSheetToKeyboard);
  }
  function closeSheet(){
    lockPage(false);
    $("#sheet").style.bottom = ""; $("#sheet").style.maxHeight = "";
    $("#scrim").classList.remove("on");
    $("#sheet").classList.remove("on");
    editing = null;
    document.activeElement && document.activeElement.blur();
  }
  function syncSheet(){
    if(!editing) return;
    document.querySelectorAll("#fSpace .chip").forEach(c=>c.setAttribute("aria-pressed", String(c.dataset.v===editing.space)));
    document.querySelectorAll("#fPrio .chip").forEach(c=>c.setAttribute("aria-pressed", String(Number(c.dataset.v)===editing.priority)));
    const t0 = todayIso(), t1 = iso(addDays(new Date(),1)), nw = nextMonday();
    const which = !editing.due ? "none" : editing.due===t0 ? "today" : editing.due===t1 ? "tomorrow" : editing.due===nw ? "nextweek" : "";
    document.querySelectorAll("#fDue .chip").forEach(c=>c.setAttribute("aria-pressed", String(c.dataset.v===which)));
    $("#fDate").value = editing.due||"";
    $("#fTime").disabled = !editing.due;
    document.body.dataset.space = editing.space;
    setSaveState();
  }
  function nextMonday(){ const d = new Date(); const add = ((8 - d.getDay()) % 7) || 7; return iso(addDays(d, add)); }
  function renderSubs(){
    const box = $("#fSubs"); box.innerHTML = "";
    editing.subtasks.forEach((s,i)=>{
      const row = document.createElement("div"); row.className="sub";
      const cb = document.createElement("input"); cb.type="checkbox"; cb.checked=!!s.done; cb.setAttribute("aria-label","Xong bước "+(i+1));
      cb.onchange = ()=>{ s.done = cb.checked; };
      const tx = document.createElement("input"); tx.type="text"; tx.value=s.text||""; tx.placeholder="Bước "+(i+1);
      tx.oninput = ()=>{ s.text = tx.value; };
      tx.onkeydown = e=>{ if(e.key==="Enter"){ e.preventDefault(); addSubStep(); } };
      const x = document.createElement("button"); x.className="x"; x.textContent="×"; x.setAttribute("aria-label","Bỏ bước này");
      x.onclick = ()=>{ editing.subtasks.splice(i,1); renderSubs(); };
      row.append(cb,tx,x); box.append(row);
    });
  }
  function addSubStep(){
    editing.subtasks.push({text:"",done:false}); renderSubs();
    const ins = $("#fSubs").querySelectorAll("input[type=text]"); ins[ins.length-1].focus();
  }
  async function saveSheet(){
    if(!editing) return;
    const title = $("#fTitle").value.trim();
    if(!title){
      const inp = $("#fTitle");
      $("#fTitleErr").hidden = false;
      inp.classList.remove("shake"); void inp.offsetWidth; inp.classList.add("shake");
      inp.focus();
      return;
    }
    const isNew = !editing.id;
    const t = Object.assign({}, editing, {
      title, note:$("#fNote").value.trim(),
      due:$("#fDate").value||"", time:$("#fDate").value ? ($("#fTime").value||"") : "",
      subtasks: editing.subtasks.filter(s=>(s.text||"").trim()).map(s=>({text:s.text.trim(), done:!!s.done})),
      updatedAt: Date.now()
    });
    if(isNew){ t.id = uid(); t.createdAt = Date.now(); tasks = tasks.concat(t); }
    else tasks = tasks.map(x=>x.id===t.id?t:x);
    if(ui.space!=="all" && ui.space!==t.space){ ui.space = t.space; saveUi(); }
    closeSheet(); render();
    toast(isNew ? "Đã thêm việc" : "Đã lưu thay đổi");
    await persist(t);
  }
  async function deleteFromSheet(){
    if(!editing || !editing.id) return;
    const t = findTask(editing.id); if(!t) return closeSheet();
    tasks = tasks.filter(x=>x.id!==t.id);
    closeSheet(); render();
    toast("Đã xoá việc", async ()=>{ tasks = tasks.concat(t); render(); await persist(t); });
    await removeStored(t.id);
  }

  /* ---------- events ---------- */
  document.querySelectorAll("button[data-s]").forEach(b=>b.addEventListener("click", ()=>{ ui.space = (b.dataset.s==="all" && ui.space==="all") ? "work" : b.dataset.s; saveUi(); render(); scrollToTop(); }));
  $("#searchBtn").onclick = ()=>{ const box=$("#searchBox"); box.classList.toggle("on"); if(box.classList.contains("on")) $("#q").focus(); else { $("#q").value=""; query=""; render(); } };
  $("#q").oninput = e=>{ query = e.target.value.trim(); render(); };
  $("#fab").onclick = ()=>openSheet(null);
  $("#scrim").onclick = closeSheet;
  $("#closeSheet").onclick = closeSheet;
  $("#saveBtn").onclick = saveSheet;
  $("#delBtn").onclick = deleteFromSheet;
  $("#addSub").onclick = addSubStep;
  function setSaveState(){
    const has = !!$("#fTitle").value.trim();
    $("#saveBtn").classList.toggle("dim", !has);
    if(has) $("#fTitleErr").hidden = true;
  }
  $("#fTitle").oninput = setSaveState;
  $("#fTitle").onkeydown = e=>{ if(e.key==="Enter"){ e.preventDefault(); saveSheet(); } };
  $("#fSpace").onclick = e=>{ const c=e.target.closest(".chip"); if(!c) return; editing.space=c.dataset.v; syncSheet(); };
  $("#fPrio").onclick = e=>{ const c=e.target.closest(".chip"); if(!c) return; editing.priority=Number(c.dataset.v); syncSheet(); };
  $("#fDue").onclick = e=>{
    const c=e.target.closest(".chip"); if(!c) return;
    const v=c.dataset.v;
    editing.due = v==="none" ? "" : v==="today" ? todayIso() : v==="tomorrow" ? iso(addDays(new Date(),1)) : nextMonday();
    if(!editing.due){ editing.time=""; $("#fTime").value=""; }
    syncSheet();
  };
  $("#fDate").onchange = e=>{ editing.due = e.target.value; syncSheet(); };
  $("#fTime").onchange = e=>{ editing.time = e.target.value; };
  document.addEventListener("keydown", e=>{ if(e.key==="Escape" && editing) closeSheet(); });
  $("#sheet").addEventListener("transitionend", ()=>{ if(!editing) render(); });

  $("#main").addEventListener("click", async e=>{
    const el = e.target.closest("[data-act]"); if(!el) return;
    const act = el.dataset.act;
    if(act==="new") return openSheet(null);
    if(act==="toggleDone"){ ui.showDone=!ui.showDone; saveUi(); return render(); }
    if(act==="clearDone"){
      const gone = tasks.filter(t=>t.done && inSpace(t));
      tasks = tasks.filter(t=>!(t.done && inSpace(t)));
      render();
      toast("Đã xoá "+gone.length+" việc đã xong", async ()=>{ tasks = tasks.concat(gone); render(); for(const t of gone) await persist(t); });
      await removeMany(gone.map(t=>t.id));
      return;
    }
    const row = el.closest(".task"); if(!row) return;
    const id = row.dataset.id;
    if(act==="toggle") return toggleTask(id);
    if(act==="open"){ const t=findTask(id); if(t) openSheet(t); }
  });

  // Refresh date groups when the day changes or the app comes back
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden){ renderDate(); render(); if(userId) refresh(); } });

  /* ---------- start ---------- */
  applyTheme();
  tickClock(); setInterval(tickClock, 30000);
  $("#themeBtn").onclick = ()=>{ const order=["auto","light","dark"]; ui.theme = order[(order.indexOf(ui.theme)+1)%3]; saveUi(); applyTheme(); };
  renderDate();
  render();
  boot();
})();
