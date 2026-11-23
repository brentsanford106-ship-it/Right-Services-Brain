import { useState } from "react";
import type { Photo } from "@rsb/contracts";
import { useOrgId, useOrgQuery } from "../lib/hooks";
import { Status } from "../components/ui";
import { applyFilter, applyPeople, FilterBar, Lightbox, PeopleAndSort, PhotoGrid, sortPhotos, SORTS, type Filter, type PeopleFilter, type Sort } from "../components/photos";

interface Criteria {
  jobNumber: string;
  site: string;
  from: string;
  to: string;
  lat: string;
  lng: string;
  radiusM: string;
}
const EMPTY: Criteria = { jobNumber: "", site: "", from: "", to: "", lat: "", lng: "", radiusM: "500" };

function toQuery(c: Criteria): string {
  const p = new URLSearchParams();
  if (c.jobNumber.trim()) p.set("jobNumber", c.jobNumber.trim());
  if (c.site.trim()) p.set("site", c.site.trim());
  if (c.from) p.set("from", c.from);
  if (c.to) p.set("to", c.to);
  if (c.lat.trim() && c.lng.trim()) {
    p.set("lat", c.lat.trim());
    p.set("lng", c.lng.trim());
    p.set("radiusM", c.radiusM || "500");
  }
  p.set("limit", "200");
  return p.toString();
}

/** Recall photos by job number, site, date, or location, across all jobs you can see. */
export function PhotoSearchPage() {
  const orgId = useOrgId();
  const [draft, setDraft] = useState<Criteria>(EMPTY);
  const [applied, setApplied] = useState<Criteria>(EMPTY);
  const [filter, setFilter] = useState<Filter>("all");
  const [people, setPeople] = useState<PeopleFilter>(new Set());
  const [sort, setSort] = useState<Sort>("newest");
  const [open, setOpen] = useState<number | null>(null);
  const q = useOrgQuery<{ items: Photo[] }>("photos", `/photos?${toQuery(applied)}`);
  const set = (k: keyof Criteria) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: e.target.value });

  return (
    <>
      <h1>Find photos</h1>
      <form
        className="form searchform"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
          setOpen(null);
        }}
      >
        <label>Job number<input value={draft.jobNumber} onChange={set("jobNumber")} placeholder="HP-1001" /></label>
        <label>Site name<input value={draft.site} onChange={set("site")} placeholder="Station" /></label>
        <label>From date<input type="date" value={draft.from} onChange={set("from")} /></label>
        <label>To date<input type="date" value={draft.to} onChange={set("to")} /></label>
        <label>Near latitude<input value={draft.lat} onChange={set("lat")} inputMode="decimal" placeholder="40.4462" /></label>
        <label>Near longitude<input value={draft.lng} onChange={set("lng")} inputMode="decimal" placeholder="-80.0021" /></label>
        <label>Within (meters)<input value={draft.radiusM} onChange={set("radiusM")} inputMode="numeric" /></label>
        <div className="actions">
          <button className="primary" type="submit">Search</button>
          <button type="button" onClick={() => { setDraft(EMPTY); setApplied(EMPTY); }}>Clear</button>
        </div>
      </form>
      <Status query={q}>
        {(d) => {
          const byPeople = applyPeople(d.items, people);
          const shown = sortPhotos(applyFilter(byPeople, filter), sort);
          return (
            <>
              <p className="muted small">{d.items.length} photo{d.items.length === 1 ? "" : "s"} found, {SORTS.find((o) => o.value === sort)!.label.toLowerCase()}{d.items.length === 200 ? " (showing the first 200; narrow the search)" : ""}</p>
              <PeopleAndSort items={d.items} people={people} onPeople={(x) => { setPeople(x); setOpen(null); }} sort={sort} onSort={(x) => { setSort(x); setOpen(null); }} />
              <FilterBar value={filter} onChange={(f) => { setFilter(f); setOpen(null); }} items={byPeople} />
              <PhotoGrid items={shown} onOpen={setOpen} showJob />
              {open !== null && <Lightbox items={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} invalidate={[[orgId]]} />}
            </>
          );
        }}
      </Status>
    </>
  );
}
