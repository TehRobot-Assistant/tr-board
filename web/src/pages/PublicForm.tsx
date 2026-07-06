import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Logo } from "./Login";

type PublicFormDef = {
  title: string;
  description: string;
  fields: Array<{ id: string; label: string; type: string; required: boolean; options?: string[] }>;
};

/** unauthenticated intake form — each submission becomes a card */
export default function PublicForm() {
  const { token } = useParams<{ token: string }>();
  const [form, setForm] = useState<PublicFormDef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`/api/public/forms/${token}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("This form doesn't exist or has been closed.");
        setForm((await r.json()).form);
      })
      .catch((e) => setError(e.message));
  }, [token]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
        <Logo />
        <p className="text-sm opacity-70">{error}</p>
      </div>
    );
  }
  if (!form) return <div className="flex h-full items-center justify-center text-sm opacity-60">Loading…</div>;

  if (done) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Logo size={44} />
        <h1 className="font-display text-xl font-bold">Thanks — got it.</h1>
        <p className="text-sm opacity-60">Your submission has been received.</p>
        <button
          className="btn-ghost mt-2 text-sm"
          onClick={() => { setAnswers({}); setDone(false); }}
        >
          Submit another
        </button>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/forms/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "submission failed");
      setDone(true);
    } catch (err: any) {
      setError(err.message);
      setForm(form); // stay on form
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full bg-paper-2 py-10 dark:bg-ink">
      <div className="mx-auto max-w-lg px-5">
        <div className="rounded-card bg-white p-6 shadow-card dark:bg-ink-2">
          <div className="mb-5 flex items-center gap-2.5">
            <Logo size={28} />
            <h1 className="font-display text-lg font-bold leading-tight">{form.title}</h1>
          </div>
          {form.description && <p className="mb-5 whitespace-pre-wrap text-sm opacity-70">{form.description}</p>}
          <form onSubmit={submit} className="space-y-4">
            {form.fields.map((f) => (
              <div key={f.id}>
                <label className="mb-1 block text-sm font-medium">
                  {f.label} {f.required && <span className="text-[#b03a37]">*</span>}
                </label>
                {f.type === "textarea" ? (
                  <textarea
                    className="input min-h-24"
                    required={f.required}
                    value={answers[f.id] ?? ""}
                    onChange={(e) => setAnswers({ ...answers, [f.id]: e.target.value })}
                  />
                ) : f.type === "select" ? (
                  <select
                    className="input"
                    required={f.required}
                    value={answers[f.id] ?? ""}
                    onChange={(e) => setAnswers({ ...answers, [f.id]: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input"
                    type={f.type === "text" ? "text" : f.type}
                    required={f.required}
                    value={answers[f.id] ?? ""}
                    onChange={(e) => setAnswers({ ...answers, [f.id]: e.target.value })}
                  />
                )}
              </div>
            ))}
            {error && <p className="text-sm text-[#b03a37]">{error}</p>}
            <button className="btn-accent w-full" disabled={busy}>
              {busy ? "Sending…" : "Submit"}
            </button>
          </form>
        </div>
        <p className="mt-3 text-center text-xs opacity-40">Powered by TR Board</p>
      </div>
    </div>
  );
}
