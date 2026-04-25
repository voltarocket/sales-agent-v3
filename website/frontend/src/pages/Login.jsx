import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../App";

export default function Login() {
  const nav = useNavigate();
  const [form, setForm]   = useState({ email: "", password: "" });
  const [err, setErr]     = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setErr(""); setLoading(true);
    try {
      const r = await api("/api/auth/login", { method: "POST", body: form });
      if (r.error) { setErr(r.error); return; }
      localStorage.setItem("token", r.token);
      localStorage.setItem("user",  JSON.stringify(r.user));
      nav("/dashboard");
    } catch { setErr("Ошибка сети"); }
    finally { setLoading(false); }
  }

  return (
    <>
      <nav>
        <Link to="/" className="nav-logo">📞 Sales Analyzer</Link>
        <div className="nav-links">
          <Link to="/"><button className="btn-secondary btn-sm">На главную</button></Link>
        </div>
      </nav>
      <div className="auth-wrap" style={{paddingTop: 80}}>
        <div className="auth-card">
          <h2>Вход</h2>
          <p className="sub">Войдите в свой аккаунт</p>
          <form onSubmit={onSubmit}>
            <div className="form-group">
              <label>Email</label>
              <input type="email" placeholder="ivan@company.ru" value={form.email}
                onChange={e => setForm({...form, email: e.target.value})} required />
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
          <p className="form-footer">Нет аккаунта? <Link to="/">Зарегистрироваться</Link></p>
        </div>
      </div>
    </>
  );
}
