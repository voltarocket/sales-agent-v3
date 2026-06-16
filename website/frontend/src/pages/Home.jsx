import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../App";

export default function Home() {
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [err, setErr]   = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setErr(""); setLoading(true);
    try {
      const r = await api("/api/auth/register", { method: "POST", body: form });
      if (r.error || !r.token) { setErr(r.error || "Ошибка регистрации"); return; }
      localStorage.setItem("token", r.token);
      localStorage.setItem("user",  JSON.stringify(r.user));
      window.location.href = "/dashboard";
    } catch { setErr("Ошибка сети"); }
    finally { setLoading(false); }
  }

  return (
    <>
      <nav>
        <span className="nav-logo">Диалог</span>
        <div className="nav-links">
          <Link to="/login"><button className="btn-secondary btn-sm">Войти</button></Link>
        </div>
      </nav>

      <div className="hero">
        <div className="hero-badge">Анализ звонков на базе ИИ</div>
        <h1>Контроль качества<br />каждого звонка</h1>
        <p>Транскрипция, оценка и рекомендации автоматически — для всей команды продаж</p>
      </div>

      <div className="auth-wrap">
        <div className="auth-card">
          <h2>Начать бесплатно</h2>
          <p className="sub">Создайте аккаунт и получите доступ к приложениям</p>
          <form onSubmit={onSubmit}>
            <div className="form-group">
              <label>Имя</label>
              <input placeholder="Иван Иванов" value={form.name}
                onChange={e => setForm({...form, name: e.target.value})} required />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input type="email" placeholder="ivan@company.ru" value={form.email}
                onChange={e => setForm({...form, email: e.target.value})} required />
            </div>
            <div className="form-group">
              <label>Пароль</label>
              <input type="password" placeholder="Минимум 6 символов" value={form.password}
                onChange={e => setForm({...form, password: e.target.value})} required />
            </div>
            {err && <p className="error-msg">{err}</p>}
            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? "Регистрация..." : "Зарегистрироваться"}
              </button>
            </div>
          </form>
          <p className="form-footer">Уже есть аккаунт? <Link to="/login">Войти</Link></p>
        </div>
      </div>
    </>
  );
}
