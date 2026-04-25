import { Routes, Route, Navigate } from "react-router-dom";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Admin from "./pages/Admin";

const API = "";

export function api(path, opts = {}) {
  const token = localStorage.getItem("token");
  return fetch(API + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-session-token": token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)) : undefined,
  }).then(r => r.json());
}

export function isLoggedIn() {
  return !!localStorage.getItem("token");
}

export default function App() {
  return (
    <Routes>
      <Route path="/"          element={<Home />} />
      <Route path="/login"     element={<Login />} />
      <Route path="/dashboard" element={isLoggedIn() ? <Dashboard /> : <Navigate to="/login" />} />
      <Route path="/admin"     element={<Admin />} />
    </Routes>
  );
}
