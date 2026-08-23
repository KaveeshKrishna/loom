"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2, UserCircle2, Pencil, X, Eye, EyeOff } from "lucide-react";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

const inputCls =
  "w-full px-3 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border focus:outline-none focus:border-[hsl(var(--primary)/0.4)]";
const selectCls =
  "w-full px-3 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border focus:outline-none";

function PasswordInput({
  id,
  value,
  onChange,
  required,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className={inputCls + " pr-9"}
        placeholder={placeholder ?? "••••••••"}
        autoComplete="new-password"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
        tabIndex={-1}
        aria-label={show ? "Hide password" : "Show password"}
      >
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

export function UsersPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  // Create form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "FAMILY" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Edit modal
  const [editUser, setEditUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState({ name: "", role: "FAMILY", password: "" });
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState("");

  const load = () => {
    fetch("/api/users")
      .then((r) => r.json())
      .then((d) => { setUsers(d.users ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // ── Create ──────────────────────────────────────────────────────────────────
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
    setShowForm(false); setSubmitting(false); load();
  };

  // ── Delete ──────────────────────────────────────────────────────────────────
  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
    await fetch(`/api/users/${id}`, { method: "DELETE" });
    load();
  };

  // ── Edit ────────────────────────────────────────────────────────────────────
  const openEdit = (user: User) => {
    setEditUser(user);
    setEditForm({ name: user.name, role: user.role, password: "" });
    setEditError("");
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
    setEditSubmitting(true); setEditError("");
    const body: Record<string, string> = { name: editForm.name, role: editForm.role };
    if (editForm.password) body.password = editForm.password;
    const res = await fetch(`/api/users/${editUser.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { setEditError(data.error ?? "Failed"); setEditSubmitting(false); return; }
    setEditUser(null); setEditSubmitting(false); load();
  };

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Users</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Manage who has access to Loom.</p>
        </div>
        <button
          id="settings-add-user"
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90 transition-opacity"
        >
          <Plus size={15} /> Add user
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="bg-[hsl(var(--card))] border rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold">New user</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium mb-1 block">Name</label>
              <input id="new-user-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required className={inputCls} placeholder="Full name" />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Email</label>
              <input id="new-user-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required className={inputCls} placeholder="user@example.com" />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Password</label>
              <PasswordInput id="new-user-password" value={form.password} onChange={(v) => setForm((f) => ({ ...f, password: v }))} required />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Role</label>
              <select id="new-user-role" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} className={selectCls}>
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

      {/* User list */}
      <div className="divide-y border rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-[hsl(var(--muted-foreground))]" /></div>
        ) : (
          users.map((user) => (
            <div key={user.id} className="flex items-center gap-3 px-4 py-3">
              <div className="w-8 h-8 rounded-full bg-[hsl(var(--primary)/0.12)] flex items-center justify-center shrink-0">
                <UserCircle2 size={18} className="text-[hsl(var(--primary))]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{user.name}</p>
                <p className="text-xs text-[hsl(var(--muted-foreground))] truncate">{user.email}</p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${user.role === "OWNER" ? "bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]" : "bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"}`}>
                {user.role === "OWNER" ? "Owner" : "Family"}
              </span>
              {user.role !== "OWNER" && (
                <>
                  <button id={`edit-user-${user.id}`} onClick={() => openEdit(user)} className="p-1.5 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--accent))] transition-colors" title="Edit user">
                    <Pencil size={14} />
                  </button>
                  <button id={`delete-user-${user.id}`} onClick={() => handleDelete(user.id, user.name)} className="p-1.5 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))] transition-colors" title="Delete user">
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>

      {/* Edit modal */}
      {editUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <form onSubmit={handleEdit} className="bg-[hsl(var(--card))] border rounded-2xl p-6 w-full max-w-sm shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Edit user</h3>
              <button type="button" onClick={() => setEditUser(null)} className="p-1 rounded-md hover:bg-[hsl(var(--accent))] transition-colors"><X size={16} /></button>
            </div>

            <div>
              <label className="text-xs font-medium mb-1 block text-[hsl(var(--muted-foreground))]">Email (read-only)</label>
              <p className="text-sm px-3 py-1.5 bg-[hsl(var(--accent)/0.5)] rounded-lg border border-dashed">{editUser.email}</p>
            </div>

            <div>
              <label className="text-xs font-medium mb-1 block">Display name</label>
              <input id="edit-user-name" value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} required className={inputCls} placeholder="Full name" />
            </div>

            <div>
              <label className="text-xs font-medium mb-1 block">Role</label>
              <select id="edit-user-role" value={editForm.role} onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))} className={selectCls}>
                <option value="FAMILY">Family</option>
                <option value="OWNER">Owner</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-medium mb-1 block">
                New password{" "}
                <span className="text-[hsl(var(--muted-foreground))] font-normal">(leave blank to keep current)</span>
              </label>
              <PasswordInput id="edit-user-password" value={editForm.password} onChange={(v) => setEditForm((f) => ({ ...f, password: v }))} />
            </div>

            {editError && <p className="text-xs text-[hsl(var(--destructive))]">{editError}</p>}

            <div className="flex gap-2 justify-end pt-1">
              <button type="button" onClick={() => setEditUser(null)} className="px-3 py-1.5 text-sm rounded-lg hover:bg-[hsl(var(--accent))] transition-colors">Cancel</button>
              <button id="edit-user-submit" type="submit" disabled={editSubmitting} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90 disabled:opacity-60 transition-all">
                {editSubmitting && <Loader2 size={13} className="animate-spin" />} Save changes
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
