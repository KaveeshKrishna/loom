"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2, ShieldCheck, ShieldX } from "lucide-react";

interface AclRule { id: string; path: string; allow: boolean; user: { id: string; name: string; email: string }; }
interface User { id: string; name: string; email: string; role: string; }

export function AclPanel() {
  const [rules, setRules] = useState<AclRule[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ userId: "", path: "", allow: "true" });
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    Promise.all([
      fetch("/api/acl").then(r => r.json()),
      fetch("/api/users").then(r => r.json()),
    ]).then(([a, u]) => {
      setRules(a.rules ?? []); setUsers((u.users ?? []).filter((u: User) => u.role !== "OWNER")); setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true);
    await fetch("/api/acl", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: form.userId, path: form.path.replace(/^\/+/, ""), allow: form.allow === "true" }),
    });
    setForm({ userId: "", path: "", allow: "true" }); setShowForm(false); setSubmitting(false); load();
  };

  const handleDelete = async (id: string) => {
    await fetch("/api/acl", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    load();
  };

  const grouped = rules.reduce((acc, rule) => {
    const key = rule.user.id;
    if (!acc[key]) acc[key] = { user: rule.user, rules: [] };
    acc[key].rules.push(rule);
    return acc;
  }, {} as Record<string, { user: AclRule["user"]; rules: AclRule[] }>);

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Permissions</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Control which folders each user can access. Deepest rule wins.</p>
        </div>
        <button id="settings-add-acl" onClick={() => setShowForm(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90 transition-opacity">
          <Plus size={15} /> Add rule
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-[hsl(var(--card))] border rounded-xl p-4 space-y-3 animate-in-slide-up">
          <h3 className="text-sm font-semibold">New permission rule</h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium mb-1 block">User</label>
              <select id="acl-user" value={form.userId} onChange={e => setForm(f => ({...f, userId: e.target.value}))} required className="w-full px-3 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border focus:outline-none">
                <option value="">Select user</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Path</label>
              <input id="acl-path" value={form.path} onChange={e => setForm(f => ({...f, path: e.target.value}))} required className="w-full px-3 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border focus:outline-none" placeholder="Pics/Private" />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Permission</label>
              <select id="acl-allow" value={form.allow} onChange={e => setForm(f => ({...f, allow: e.target.value}))} className="w-full px-3 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border focus:outline-none">
                <option value="true">Allow</option>
                <option value="false">Deny</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowForm(false)} className="px-3 py-1.5 text-sm rounded-lg hover:bg-[hsl(var(--accent))] transition-colors">Cancel</button>
            <button id="acl-submit" type="submit" disabled={submitting} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90 disabled:opacity-60 transition-all">
              {submitting && <Loader2 size={13} className="animate-spin" />} Save rule
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-[hsl(var(--muted-foreground))]" /></div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="text-center py-12 text-[hsl(var(--muted-foreground))] text-sm">No rules yet. Add rules to grant folder access to users.</div>
      ) : (
        <div className="space-y-4">
          {Object.values(grouped).map(({ user, rules: userRules }) => (
            <div key={user.id} className="border rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-[hsl(var(--accent)/0.5)] border-b">
                <p className="text-sm font-medium">{user.name}</p>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">{user.email}</p>
              </div>
              {userRules.sort((a,b) => a.path.localeCompare(b.path)).map(rule => (
                <div key={rule.id} className="flex items-center gap-3 px-4 py-2.5 border-b last:border-0">
                  {rule.allow ? <ShieldCheck size={15} className="text-emerald-500 shrink-0" /> : <ShieldX size={15} className="text-rose-500 shrink-0" />}
                  <code className="text-xs font-mono flex-1">{rule.path || "/"}</code>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${rule.allow ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/10 text-rose-600 dark:text-rose-400"}`}>
                    {rule.allow ? "Allow" : "Deny"}
                  </span>
                  <button id={`delete-acl-${rule.id}`} onClick={() => handleDelete(rule.id)} className="p-1.5 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))] transition-colors">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
