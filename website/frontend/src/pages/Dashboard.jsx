import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../App";

export default function Dashboard() {
  const nav = useNavigate();
  const [user,      setUser]      = useState(JSON.parse(localStorage.getItem("user") || "null"));
  const [downloads, setDownloads] = useState([]);
  const [copied,    setCopied]    = useState(false);

  useEffect(() => {
    api("/api/user/me").then(r => { if (!r.error) { setUser(r); localStorage.setItem("user", JSON.stringify(r)); } });
    api("/api/user/downloads").then(r => { if (Array.isArray(r)) setDownloads(r); });
  }, []);

  function copyKey() {
    navigator.clipboard.writeText(user?.license_key || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function logout() {
    api("/api/auth/logout", { method: "POST" });
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    nav("/");
  }

  return (
    <>
      <nav>
        <Link to="/" className="nav-logo">📞 Sales Analyzer</Link>
        <div className="nav-links">
          {user && <span className="user-badge">👤 {user.name || user.email}</span>}
          <button className="btn-secondary btn-sm" onClick={logout}>Выйти</button>
        </div>
      </nav>

      <div className="page">
        <h2 className="section-title">Добро пожаловать, {user?.name || ""}!</h2>

        {/* License key */}
        <div className="card mt-24">
          <h3 style={{marginBottom: 12, fontSize: 15, color: "var(--muted)"}}>Ваш лицензионный ключ</h3>
          <div className="license-box">
            <code style={{overflow: "hidden", textOverflow: "ellipsis"}}>{user?.license_key || "Загрузка..."}</code>
            <button className="copy-btn" onClick={copyKey}>{copied ? "✓" : "Копировать"}</button>
          </div>
          <p className="text-muted mt-12">Введите этот ключ в настройках локального бэкенда (<code>backend/.env → LICENSE_KEY</code>)</p>
        </div>

        {/* Downloads */}
        <h2 className="section-title" style={{marginTop: 40}}>Скачать приложения</h2>
        <div className="downloads-grid">
          {downloads.map(d => (
            <div className="download-card" key={d.id}>
              <div className="dl-icon">{d.icon}</div>
              <h3>{d.title}</h3>
              <p>{d.desc}</p>
              <a href={d.url} download>
                <button className="btn-primary btn-sm">Скачать</button>
              </a>
            </div>
          ))}
          {downloads.length === 0 && (
            <p className="text-muted">Загрузка...</p>
          )}
        </div>

        {/* Instructions */}
        <div className="card mt-24">
          <h3 style={{marginBottom: 16, fontSize: 16}}>Как начать</h3>
          {[
            { n: "1", text: "Скачайте и установите Desktop App и Admin App" },
            { n: "2", text: "Скачайте docker-compose.yml и запустите docker compose up -d" },
            { n: "3", text: `Добавьте ключ лицензии в backend/.env: LICENSE_KEY=${user?.license_key || "..."}` },
            { n: "4", text: `Войдите в Admin App с вашим email: ${user?.email || "..."}` },
          ].map(s => (
            <div key={s.n} style={{display:"flex", gap:12, marginBottom:12, alignItems:"flex-start"}}>
              <span style={{background:"var(--accent)", borderRadius:"50%", width:24, height:24, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, flexShrink:0}}>{s.n}</span>
              <span style={{fontSize:14, color:"var(--muted)", lineHeight:1.5}}>{s.text}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
