import { useState } from "react";

export interface JobFormValues {
  jobNumber?: string;
  title: string;
  siteName?: string | null;
  siteAddress?: string | null;
  status: string;
}

const STATUSES = ["planned", "active", "on_hold", "completed", "cancelled"];

export function JobForm(props: { initial?: Partial<JobFormValues>; editing?: boolean; submitLabel: string; busy: boolean; error: string | null; onSubmit: (v: JobFormValues) => void; onCancel: () => void }) {
  const i = props.initial ?? {};
  const [jobNumber, setJobNumber] = useState(i.jobNumber ?? "");
  const [title, setTitle] = useState(i.title ?? "");
  const [siteName, setSiteName] = useState(i.siteName ?? "");
  const [siteAddress, setSiteAddress] = useState(i.siteAddress ?? "");
  const [status, setStatus] = useState(i.status ?? "active");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const base = { title: title.trim(), status };
    props.onSubmit(
      props.editing
        ? { ...base, siteName: siteName.trim() || null, siteAddress: siteAddress.trim() || null }
        : { ...base, jobNumber: jobNumber.trim(), ...(siteName.trim() ? { siteName: siteName.trim() } : {}), ...(siteAddress.trim() ? { siteAddress: siteAddress.trim() } : {}) },
    );
  };
  return (
    <form className="form" onSubmit={submit}>
      <label>Job number<input value={jobNumber} onChange={(e) => setJobNumber(e.target.value)} disabled={props.editing} required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,39}" placeholder="HP-1004" /></label>
      <label>Job name<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></label>
      <label>Site name<input value={siteName} onChange={(e) => setSiteName(e.target.value)} maxLength={200} /></label>
      <label>Site address<input value={siteAddress} onChange={(e) => setSiteAddress(e.target.value)} maxLength={500} /></label>
      <label>Status
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
      </label>
      {props.error && <p className="error" role="alert">{props.error}</p>}
      <div className="actions">
        <button className="primary" type="submit" disabled={props.busy}>{props.submitLabel}</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}
