import { useState, useEffect } from "react";
import { api } from "../App";

function fmt(dt) {
  if (!dt) return "—";
  return new Date(dt).toLocaleString("ru", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
}

export default function Admin() {
  const [loggedIn, setLoggedIn] = useState(!!localStorage.getItem("admin-token"));
  const [form, setForm]   = useState({ username: "", password: "" });
  const [err,  setErr]    = useState("");
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);

  function adminApi(path, opts = {}) {
    const token = localStorage.getItem("admin-token");
    return fetch(path, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-admin-token": token } : {}),
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(r => r.json());
  }

  async function login(e) {
    e.preventDefault();
    setErr(""); setLoading(true);
    try {
      const r = await adminApi("/api/admin/login", { method: "POST", body: form });
      if (r.error) { setErr(r.error); return; }
      localStorage.setItem("admin-token", r.token);
      setLoggedIn(true);
    } catch { setErr("Ошибка сети"); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (!loggedIn) return;
    adminApi("/api/admin/users").then(r => { if (Array.isArray(r)) setUsers(r); });
    adminApi("/api/admin/stats").then(r => { if (r.total_users !== undefined) setStats(r); });
  }, [loggedIn]);

  async function toggleUser(uid) {
    const r = await adminApi(`/api/admin/users/${uid}/toggle`, { method: "PATCH" });
    if (r.ok) setUsers(us => us.map(u => u.id === uid ? {...u, is_active: r.is_active} : u));
  }

  if (!loggedIn) {
    return (
      <>
        <nav>
          <span className="nav-logo">📞 Sales Analyzer — Admin</span>
        </nav>
        <div className="auth-wrap" style={{paddingTop: 80}}>
          <div className="auth-card">
            <h2>Вход для администратора</h2>
            <p className="sub">Управление пользователями</p>
            <form onSubmit={login}>
              <div className="form-group">
                <label>Логин</label>
                <input placeholder="admin" value={form.username}
                  onChange={e => setForm({...form, username: e.target.value})} required />
              </div>
              <div className="form-group">
                <label>Пароль</label>
                <input type="password" placeholder="••••••••" value={form.password}
                  onChange={e => setForm({...form, password: e.target.value})} required />
              </div>
              {err && <p className="error-msg">{err}</p>}
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? "Вход..." : "Войти"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <nav>
        <span className="nav-logo">📞 Sales Analyzer — Admin Panel</span>
        <button className="btn-secondary btn-sm" onClick={() => { localStorage.removeItem("admin-token"); setLoggedIn(false); }}>
          Выйти
        </button>
      </nav>

      <div className="page">
        <h2 className="section-title">Пользователи</h2>

        {stats && (
          <div className="stats-grid">
            <div className="stat-card"><div className="stat-val">{stats.total_users}</div><div className="stat-label">Всего</div></div>
            <div className="stat-card"><div className="stat-val">{stats.active_users}</div><div className="stat-label">Активных</div></div>
            <div className="stat-card"><div className="stat-val">{stats.total_calls}</div><div className="stat-label">Звонков</div></div>
          </div>
        )}

        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th><th>Имя</th><th>Email</th><th>Лицензионный ключ</th>
                  <th>Звонков</th><th>Последний вход</th><th>Регистрация</th><th>Статус</th><th></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td style={{color:"var(--muted)"}}>{u.id}</td>
                    <td>{u.name || "—"}</td>
                    <td>{u.email}</td>
                    <td><code style={{fontSize:11}}>{u.license_key || "—"}</code></td>
                    <td>{u.calls_analyzed}</td>
                    <td className="text-muted">{fmt(u.last_login)}</td>
                    <td className="text-muted">{fmt(u.created_at)}</td>
                    <td><span className={`badge ${u.is_active ? "badge-green" : "badge-red"}`}>{u.is_active ? "Активен" : "Заблокирован"}</span></td>
                    <td>
                      <button className={`btn-sm ${u.is_active ? "btn-danger" : "btn-secondary"}`} onClick={() => toggleUser(u.id)}>
                        {u.is_active ? "Блок" : "Разблок"}
                      </button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && <tr><td colSpan={9} style={{textAlign:"center", color:"var(--muted)", padding:32}}>Нет пользователей</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
