"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2, UserCircle2 } from "lucide-react";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

export function UsersPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "FAMILY" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    fetch("/api/users").then(r => r.json()).then(d => { setUsers(d.users ?? []); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true); setError("");
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error ?? "Failed"); setSubmitting(false); return; }
    setForm({ name: "", email: "", password: "", role: "FAMILY" });
    setShowForm(false);
    setSubmitting(false);
    load();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
    await fetch(`/api/users/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Users</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Manage who has access to Loom.</p>
        </div>
        <button
          id="settings-add-user"
          onClick={() => setShowForm(v => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90 transition-opacity"
        >
          <Plus size={15} /> Add user
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-[hsl(var(--card))] border rounded-xl p-4 space-y-3 animate-in-slide-up">
          <h3 className="text-sm font-semibold">New user</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1 block">Name</label>
              <input id="new-user-name" value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} required className="w-full px-3 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border focus:outline-none focus:border-[hsl(var(--primary)/0.4)]" placeholder="Full name" />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Email</label>
              <input id="new-user-email" type="email" value={form.email} onChange={e => setForm(f => ({...f, email: e.target.value}))} required className="w-full px-3 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border focus:outline-none focus:border-[hsl(var(--primary)/0.4)]" placeholder="user@example.com" />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Password</label>
              <input id="new-user-password" type="password" value={form.password} onChange={e => setForm(f => ({...f, password: e.target.value}))} required className="w-full px-3 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border focus:outline-none focus:border-[hsl(var(--primary)/0.4)]" placeholder="••••••••" />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Role</label>
              <select id="new-user-role" value={form.role} onChange={e => setForm(f => ({...f, role: e.target.value}))} className="w-full px-3 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border focus:outline-none">
                <option value="FAMILY">Family</option>
                <option value="OWNER">Owner</option>
              </select>
            </div>
          </div>
          {error && <p className="text-xs text-[hsl(var(--destructive))]">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowForm(false)} className="px-3 py-1.5 text-sm rounded-lg hover:bg-[hsl(var(--accent))] transition-colors">Cancel</button>
            <button id="new-user-submit" type="submit" disabled={submitting} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90 disabled:opacity-60 transition-all">
              {submitting && <Loader2 size={13} className="animate-spin" />} Create
            </button>
          </div>
        </form>
      )}

      <div className="divide-y border rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-[hsl(var(--muted-foreground))]" /></div>
        ) : users.map(user => (
          <div key={user.id} className="flex items-center gap-3 px-4 py-3">
            <div className="w-8 h-8 rounded-full bg-[hsl(var(--primary)/0.12)] flex items-center justify-center shrink-0">
              <UserCircle2 size={18} className="text-[hsl(var(--primary))]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{user.name}</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">{user.email}</p>
            </div>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${user.role === "OWNER" ? "bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]" : "bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"}`}>
              {user.role === "OWNER" ? "Owner" : "Family"}
            </span>
            {user.role !== "OWNER" && (
              <button id={`delete-user-${user.id}`} onClick={() => handleDelete(user.id, user.name)} className="p-1.5 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))] transition-colors">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
