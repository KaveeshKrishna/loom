"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2, ShieldCheck, ShieldX, X, Pencil } from "lucide-react";

interface AclRule { id: string; path: string; allow: boolean; user: { id: string; name: string; email: string }; }
interface User { id: string; name: string; email: string; role: string; }
interface Entry { id?: string; path: string; allow: string; }

const inputCls = "w-full px-3 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border focus:outline-none focus:border-[hsl(var(--primary)/0.4)]";
const selectCls = "w-full px-3 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border focus:outline-none";

const emptyEntry = (): Entry => ({ path: "", allow: "true" });

export function AclPanel() {
  const [rules, setRules] = useState<AclRule[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Multi-entry create form
  const [selectedUser, setSelectedUser] = useState("");
  const [entries, setEntries] = useState<Entry[]>([emptyEntry()]);
  const [originalEntries, setOriginalEntries] = useState<Entry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  const load = () => {
    Promise.all([
      fetch("/api/acl").then((r) => r.json()),
      fetch("/api/users").then((r) => r.json()),
    ]).then(([a, u]) => {
      setRules(a.rules ?? []);
      setUsers((u.users ?? []).filter((u: User) => u.role !== "OWNER"));
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // ── Entry helpers ────────────────────────────────────────────────────────────
  const updateEntry = (idx: number, field: keyof Entry, value: string) =>
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, [field]: value } : e)));
  const addEntry = () => setEntries((prev) => [...prev, emptyEntry()]);
  const removeEntry = (idx: number) => setEntries((prev) => prev.filter((_, i) => i !== idx));

  // ── Create/Edit ──────────────────────────────────────────────────────────────
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) { setFormError("Please select a user."); return; }
    if (entries.some((en) => !en.path.trim())) { setFormError("All path fields are required."); return; }
    setSubmitting(true); setFormError("");

    const toDelete = originalEntries.filter(o => !entries.find(e => e.id === o.id));
    const toUpdateOrCreate = entries.filter(e => {
      if (!e.id) return true;
      const orig = originalEntries.find(o => o.id === e.id);
      if (!orig) return true;
      return orig.path !== e.path || orig.allow !== e.allow;
    });

    const results = await Promise.all([
      ...toUpdateOrCreate.map((en) =>
        fetch("/api/acl", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: selectedUser,
            path: en.path.replace(/^\/+|\/+$/g, "").trim(),
            allow: en.allow === "true",
          }),
        })
      ),
      ...toDelete.map((en) =>
        fetch("/api/acl", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: en.id }),
        })
      )
    ]);

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      setFormError(`${failed.length} rule(s) failed to save.`);
    } else {
      setSelectedUser(""); setEntries([emptyEntry()]); setOriginalEntries([]); setShowForm(false);
    }
    setSubmitting(false); load();
  };

  const startFullEdit = (userId: string, userRules: AclRule[]) => {
    setSelectedUser(userId);
    const initialEntries = userRules.map(r => ({ id: r.id, path: r.path, allow: r.allow ? "true" : "false" }));
    setEntries(initialEntries);
    setOriginalEntries(initialEntries);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ── Delete ───────────────────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    await fetch("/api/acl", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Permissions</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Control which folders each user can access. Deepest rule wins.</p>
        </div>
        <button
          id="settings-add-acl"
          onClick={() => { setShowForm((v) => !v); setFormError(""); setSelectedUser(""); setEntries([emptyEntry()]); setOriginalEntries([]); }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90 transition-opacity"
        >
          <Plus size={15} /> Add rules
        </button>
      </div>

      {/* Multi-entry create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="bg-[hsl(var(--card))] border rounded-xl p-4 space-y-4">
          <h3 className="text-sm font-semibold">New permission rules</h3>

          <div>
            <label className="text-xs font-medium mb-1 block">User</label>
            <select id="acl-user" value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)} required className={selectCls}>
              <option value="">Select user…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_120px_32px] gap-2 mb-1">
              <span className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Path</span>
              <span className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Permission</span>
              <span />
            </div>
            {entries.map((en, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_120px_32px] gap-2 items-center">
                <input
                  id={`acl-path-${idx}`}
                  value={en.path}
                  onChange={(e) => updateEntry(idx, "path", e.target.value)}
                  required
                  className={inputCls}
                  placeholder="Pics/Private"
                />
                <select
                  id={`acl-allow-${idx}`}
                  value={en.allow}
                  onChange={(e) => updateEntry(idx, "allow", e.target.value)}
                  className={selectCls}
                >
                  <option value="true">Allow</option>
                  <option value="false">Deny</option>
                </select>
                {entries.length > 1 ? (
                  <button type="button" onClick={() => removeEntry(idx)} className="p-1.5 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))] transition-colors" title="Remove row">
                    <X size={14} />
                  </button>
                ) : <span />}
              </div>
            ))}
            <button type="button" onClick={addEntry} className="flex items-center gap-1 text-xs text-[hsl(var(--primary))] hover:underline mt-1">
              <Plus size={12} /> Add another path
            </button>
          </div>

          {formError && <p className="text-xs text-[hsl(var(--destructive))]">{formError}</p>}

          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => { setShowForm(false); setEntries([emptyEntry()]); setOriginalEntries([]); setSelectedUser(""); }} className="px-3 py-1.5 text-sm rounded-lg hover:bg-[hsl(var(--accent))] transition-colors">Cancel</button>
            <button id="acl-submit" type="submit" disabled={submitting} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90 disabled:opacity-60 transition-all">
              {submitting && <Loader2 size={13} className="animate-spin" />}
              Save {entries.length > 1 ? `${entries.length} rules` : "rule"}
            </button>
          </div>
        </form>
      )}

      {/* Rules list */}
      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-[hsl(var(--muted-foreground))]" /></div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="text-center py-12 text-[hsl(var(--muted-foreground))] text-sm">No rules yet. Add rules to grant folder access to users.</div>
      ) : (
        <div className="space-y-4">
          {Object.values(grouped).map(({ user, rules: userRules }) => (
            <div key={user.id} className="border rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 bg-[hsl(var(--accent)/0.5)] border-b">
                <div>
                  <p className="text-sm font-medium">{user.name}</p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">{user.email}</p>
                </div>
                <button
                  onClick={() => startFullEdit(user.id, userRules)}
                  className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--primary))] hover:bg-[hsl(var(--accent))] rounded-lg transition-colors"
                >
                  <Pencil size={12} /> Edit
                </button>
              </div>
              {userRules.sort((a, b) => a.path.localeCompare(b.path)).map((rule) => {
                return (
                  <div key={rule.id} className="flex items-center gap-3 px-4 py-2.5 border-b last:border-0">
                    {/* Allow/Deny icon */}
                    {rule.allow
                      ? <ShieldCheck size={15} className="text-emerald-500 shrink-0" />
                      : <ShieldX size={15} className="text-rose-500 shrink-0" />}

                    <code className="text-xs font-mono flex-1">{rule.path || "/"}</code>

                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${rule.allow ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/10 text-rose-600 dark:text-rose-400"}`}>
                      {rule.allow ? "Allow" : "Deny"}
                    </span>

                    <button
                      id={`delete-acl-${rule.id}`}
                      onClick={() => handleDelete(rule.id)}
                      className="p-1.5 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))] transition-colors"
                      title="Delete rule"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
