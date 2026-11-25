import React, { useCallback, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { ApiError, NetworkError, SORT_LABELS, applyPeople, peopleOf, sortByView, type Sort } from "@rsb/photo-sync";
import { useApp, useQueueVersion, useSyncStatus, type Job } from "../../../src/state";
import { applyFilter, mergeGallery, LocalImage, PersonBadge, ServerImage, type Filter, type GalleryItem, type ServerPhoto } from "../../../src/photos";
import { confirmDelete, sharePhotos } from "../../../src/photoActions";
import { importFromLibrary } from "../../../src/importPhotos";
import { BrandGradient, C, Chip, DevBanner, Empty, FlagBadge, Icon, JOB_STATUSES, R, StatusPill, SyncPill, s } from "../../../src/ui";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "before", label: "Before" },
  { value: "during", label: "During" },
  { value: "after", label: "After" },
  { value: "flagged", label: "Flagged" },
  { value: "comments", label: "Comments" },
  { value: "issues", label: "To fix" },
];

export default function JobGallery() {
  const app = useApp();
  useQueueVersion();
  const sync = useSyncStatus();
  const { jobId, jobNumber, title } = useLocalSearchParams<{ jobId: string; jobNumber?: string; title?: string }>();
  const [server, setServer] = useState<ServerPhoto[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  // Who took it: empty = everyone; "me" = Photos I took; otherwise people's ids (several allowed).
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<Sort>("oldest");
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  // Select mode, like the iPhone Photos app: tap Select, tap photos, then Share or Delete.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState(false);
  // How many photos are in Recently deleted; null when this person can't restore (or we're offline).
  const [deletedCount, setDeletedCount] = useState<number | null>(null);
  const { width } = useWindowDimensions();
  const cols = width >= 700 ? 5 : 3; // iPad shows more per row
  const size = Math.floor((width - 4 * (cols + 1)) / cols);

  const load = useCallback(async () => {
    setLoading(true);
    // Recently deleted: the server only answers for people allowed to restore photos.
    app.api
      .get<{ items: unknown[] }>(`/v1/orgs/${app.session!.orgId}/jobs/${jobId}/photos/deleted`)
      .then((r) => setDeletedCount(r.items.length))
      .catch(() => setDeletedCount(null));
    // Job details (status etc.): from the server when online, otherwise the copy saved on this phone.
    app.api
      .get<Job>(`/v1/orgs/${app.session!.orgId}/jobs/${jobId}`)
      .then(async (j) => {
        setJob(j);
        await app.cache.put(`job-${jobId}`, j);
      })
      .catch(async () => setJob((await app.cache.get<Job>(`job-${jobId}`)) ?? null));
    try {
      const res = await app.api.get<{ items: ServerPhoto[] }>(`/v1/orgs/${app.session!.orgId}/jobs/${jobId}/photos`);
      setServer(res.items);
      setNote(null);
      for (const p of res.items) await app.queue.absorbServer(p);
      await app.cache.put(`photos-${jobId}`, res.items);
    } catch (e) {
      setServer((await app.cache.get<ServerPhoto[]>(`photos-${jobId}`)) ?? []);
      setNote(e instanceof NetworkError ? "Offline: showing what's saved on this phone. Older photos need a connection to view." : "Couldn't refresh from the server.");
    } finally {
      setLoading(false);
    }
  }, [app.api, app.cache, app.queue, app.session, jobId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const all = mergeGallery(app.queue, jobId, server, sync.uploadingId, { name: app.session?.displayName ?? "", membershipId: app.session?.membershipId ?? null, avatarAt: app.session?.avatarAt ?? null });
  const items = useMemo(() => sortByView(applyFilter(applyPeople(all, people), filter), sort), [all, people, filter, sort]);
  const peopleList = peopleOf(all);
  const togglePerson = (key: string) =>
    setPeople((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const chooseSort = () =>
    Alert.alert("Sort photos", undefined, [
      ...(Object.keys(SORT_LABELS) as Sort[]).map((k) => ({ text: `${k === sort ? "✓ " : ""}${SORT_LABELS[k]}`, onPress: () => setSort(k) })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  const openIssues = server.reduce((n, p) => n + (p.openIssueCount ?? 0), 0);
  const waiting = all.filter((i) => i.state === "waiting" || i.state === "uploading").length;
  const attention = all.filter((i) => i.state === "needs_attention").length;

  const changeStatus = () => {
    if (!job) return;
    Alert.alert("Job status", `${job.jobNumber}: choose a new status. This needs a connection.`, [
      ...JOB_STATUSES.filter((x) => x.value !== job.status).map((x) => ({
        text: x.label,
        onPress: () => {
          app.api
            .patch<Job>(`/v1/orgs/${app.session!.orgId}/jobs/${jobId}`, { status: x.value })
            .then(async () => {
              const next = { ...job, status: x.value };
              setJob(next);
              await app.cache.put(`job-${jobId}`, next);
            })
            .catch((e) =>
              Alert.alert(
                "Status not changed",
                e instanceof NetworkError ? "No connection. Try again when you have signal." : e instanceof ApiError ? e.message : "Please try again.",
              ),
            );
        },
      })),
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const startSelecting = (first?: GalleryItem) => {
    setSelecting(true);
    setSelected(new Set(first ? [first.key] : []));
  };
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const chosen = all.filter((i) => selected.has(i.key));
  const allShownSelected = items.length > 0 && items.every((i) => selected.has(i.key));
  const onDelete = () =>
    confirmDelete(app, chosen, () => {
      stopSelecting();
      void load();
    });
  const onShare = async () => {
    setBusyAction(true);
    try {
      await sharePhotos(app, chosen, job?.jobNumber ?? jobNumber ?? "job");
    } finally {
      setBusyAction(false);
    }
  };

  const [importing, setImporting] = useState(false);
  const addFromLibrary = () =>
    Alert.alert("Add photos from your library", "Which stage are these photos?", [
      ...(["before", "during", "after"] as const).map((st) => ({
        text: st.charAt(0).toUpperCase() + st.slice(1),
        onPress: () => {
          setImporting(true);
          void importFromLibrary(app, { jobId, jobNumber: job?.jobNumber ?? jobNumber ?? "" }, st).finally(() => setImporting(false));
        },
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);

  const open = (i: GalleryItem) =>
    router.push({ pathname: "/photo/[key]", params: { key: i.key, jobId, ids: items.map((x) => x.key).join(",") } });

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: jobNumber ?? "Photos",
          // Dark top bar that runs into the dark job band below it.
          headerStyle: { backgroundColor: C.header },
          headerTintColor: "#fff",
          headerTitleStyle: { color: "#fff" },
          headerShadowVisible: false,
          headerUserInterfaceStyle: "dark",
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 18, alignItems: "center" }}>
              {selecting ? (
                <Pressable hitSlop={12} onPress={() => setSelected(allShownSelected ? new Set() : new Set(items.map((i) => i.key)))}>
                  <Text style={{ color: "#fff", fontSize: 16 }}>{allShownSelected ? "Deselect All" : "Select All"}</Text>
                </Pressable>
              ) : app.can("jobs.manage") ? (
                <Pressable hitSlop={12} onPress={() => router.push({ pathname: "/jobs/edit", params: { jobId } })}>
                  <Text style={{ color: "#fff", fontSize: 16 }}>Edit job</Text>
                </Pressable>
              ) : null}
              {all.length ? (
                <Pressable hitSlop={12} onPress={() => (selecting ? stopSelecting() : startSelecting())}>
                  <Text style={{ color: "#fff", fontSize: 16, fontWeight: selecting ? "700" : "400" }}>{selecting ? "Cancel" : "Select"}</Text>
                </Pressable>
              ) : null}
            </View>
          ),
        }}
      />
      <DevBanner />
      {/* Dark job band: name, status, photo count, and links to Issues / Recently Deleted. */}
      <View style={{ backgroundColor: C.header, paddingHorizontal: 18, paddingTop: 6, paddingBottom: 16 }}>
        <Text style={{ fontSize: 12, fontWeight: "800", color: "#ff7d96", letterSpacing: 0.8 }}>{job?.jobNumber ?? jobNumber}</Text>
        {title || job ? (
          <Text style={{ fontSize: 23, color: "#fff", fontWeight: "800", letterSpacing: -0.4, marginTop: 2 }} numberOfLines={2}>
            {job?.title ?? title}
          </Text>
        ) : null}
        {job?.siteName ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 }}>
            <Icon name="pin" size={13} color="rgba(255,255,255,0.65)" />
            <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 13.5, flexShrink: 1 }} numberOfLines={1}>
              {job.siteName}
            </Text>
          </View>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          {job ? <StatusPill status={job.status} onPress={app.can("jobs.manage") ? changeStatus : undefined} /> : null}
          <Text style={{ color: "rgba(255,255,255,0.75)", fontSize: 13.5, flexShrink: 1 }}>
            {all.length} photo{all.length === 1 ? "" : "s"}
            {waiting ? ` · ${waiting} waiting to upload` : ""}
            {attention ? ` · ${attention} need attention` : ""}
          </Text>
        </View>
        {note ? <Text style={{ color: "rgba(255,255,255,0.7)", marginTop: 8, fontSize: 13 }}>{note}</Text> : null}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <BandLink
            icon="wrench"
            label={`Issues${openIssues ? ` · ${openIssues} to fix` : ""}`}
            highlight={openIssues > 0}
            onPress={() => router.push({ pathname: "/issues", params: { jobId, jobNumber: job?.jobNumber ?? jobNumber ?? "" } })}
          />
          {deletedCount ? (
            <BandLink
              icon="trash"
              label={`Recently Deleted · ${deletedCount}`}
              onPress={() => router.push({ pathname: "/jobs/[jobId]/deleted", params: { jobId, jobNumber: job?.jobNumber ?? jobNumber ?? "" } })}
            />
          ) : null}
          <View style={{ flex: 1 }} />
          <BandLink icon="sort" label={SORT_LABELS[sort]} onPress={chooseSort} accessibilityLabel={`Sort: ${SORT_LABELS[sort]}`} />
        </View>
      </View>
      {/* flexShrink 0: with many photos the list below used to squeeze this row and cut the labels off. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0 }} contentContainerStyle={{ padding: 12, paddingHorizontal: 16 }}>
        {FILTERS.map((f) => (
          <Chip key={f.value} label={f.label} active={filter === f.value} tone={f.value === "flagged" ? "flag" : undefined} onPress={() => setFilter(f.value)} />
        ))}
      </ScrollView>
      {/* Who took it. Only shown when more than one person (or an unknown photographer) is in this job. */}
      {peopleList.length > 1 || (peopleList.length === 1 && peopleList[0]!.key !== "me") ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <Chip label="Everyone" active={people.size === 0} onPress={() => setPeople(new Set())} />
          {peopleList.map((p) => (
            <Chip
              key={p.key}
              label={`${p.key === "me" ? "Photos I took" : p.name ?? "Unknown"} (${p.count})`}
              active={people.has(p.key)}
              onPress={() => togglePerson(p.key)}
            />
          ))}
        </ScrollView>
      ) : null}
      <FlatList
        style={{ flex: 1 }}
        key={cols}
        data={items}
        numColumns={cols}
        keyExtractor={(i) => i.key}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
        contentContainerStyle={{ padding: 4, paddingBottom: 120 }}
        ListEmptyComponent={loading ? undefined : <Empty icon="camera" title={filter === "all" && people.size === 0 ? "No photos yet" : "No photos match this filter"} body={filter === "all" && people.size === 0 ? "Tap “Take Photos” to start." : undefined} />}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => (selecting ? toggle(item.key) : open(item))}
            onLongPress={() => (selecting ? toggle(item.key) : startSelecting(item))}
            style={{ margin: 2, width: size, height: size }}
            accessibilityLabel={`${item.stage} photo, taken by ${item.personKey === "me" ? "you" : item.personName ?? "unknown"}${item.flagged ? ", flagged" : ""}${item.server?.commentCount ? `, ${item.server.commentCount} comments` : ""}${item.server?.openIssueCount ? `, ${item.server.openIssueCount} to fix` : ""}${selecting ? (selected.has(item.key) ? ", selected" : ", not selected") : ""}`}
          >
            {item.local && !item.local.remoteOnly ? (
              <LocalImage localId={item.local.localId} which="thumbnail" style={{ width: size, height: size, borderRadius: 8 }} />
            ) : item.server?.hasPreview ? (
              <ServerImage photoId={item.server.id} style={{ width: size, height: size, borderRadius: 8 }} thumb />
            ) : (
              <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: C.line, alignItems: "center", justifyContent: "center" }}>
                <Text style={s.muted}>No picture</Text>
              </View>
            )}
            {item.flagged ? (
              <View style={{ position: "absolute", top: 4, right: 4 }}>
                <FlagBadge />
              </View>
            ) : null}
            {((item.server?.commentCount ?? 0) > 0 || (item.server?.openIssueCount ?? 0) > 0) && !selecting ? (
              <View pointerEvents="none" style={{ position: "absolute", top: 4, left: 4, flexDirection: "row", gap: 3 }}>
                {(item.server?.openIssueCount ?? 0) > 0 ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "#b45309", borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 }}>
                    <Icon name="wrench" size={10} color="#fff" strokeWidth={2.6} />
                    <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>{item.server?.openIssueCount}</Text>
                  </View>
                ) : null}
                {(item.server?.commentCount ?? 0) > 0 ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "rgba(0,0,0,0.65)", borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 }}>
                    <Icon name="message" size={10} color="#fff" strokeWidth={2.6} />
                    <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>{item.server?.commentCount}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            <View style={{ position: "absolute", bottom: 4, left: 4 }}>
              {item.state !== "server" && item.state !== "server_missing_file" ? <SyncPill state={item.state} compact /> : null}
            </View>
            {!selecting ? (
              <View pointerEvents="none" style={{ position: "absolute", bottom: 5, right: 5 }}>
                <PersonBadge personKey={item.personKey} name={item.personName} personId={item.personId} avatarAt={item.personAvatarAt} />
              </View>
            ) : null}
            {item.flagged ? <View pointerEvents="none" style={{ position: "absolute", inset: 0, borderWidth: 3, borderColor: C.flag, borderRadius: 8 }} /> : null}
            {selecting ? (
              <View pointerEvents="none" style={{ position: "absolute", inset: 0, borderRadius: 8, backgroundColor: selected.has(item.key) ? "rgba(255,255,255,0.35)" : "transparent" }}>
                <View
                  style={{
                    position: "absolute",
                    right: 6,
                    bottom: 6,
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    borderWidth: 2,
                    borderColor: "#fff",
                    backgroundColor: selected.has(item.key) ? "#0a84ff" : "rgba(0,0,0,0.25)",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {selected.has(item.key) ? <Text style={{ color: "#fff", fontWeight: "800", fontSize: 13 }}>✓</Text> : null}
                </View>
              </View>
            ) : null}
          </Pressable>
        )}
      />
      {selecting ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            paddingTop: 12,
            paddingBottom: 34,
            paddingHorizontal: 20,
            backgroundColor: C.card,
            borderTopWidth: 1,
            borderTopColor: C.line,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Pressable accessibilityRole="button" disabled={!chosen.length || busyAction} hitSlop={12} onPress={() => void onShare()}>
            <Text style={{ fontSize: 17, color: chosen.length ? "#0a84ff" : C.muted }}>{busyAction ? "Preparing…" : "Share"}</Text>
          </Pressable>
          <Text style={{ fontSize: 15, fontWeight: "600", color: C.text }}>
            {chosen.length ? `${chosen.length} Photo${chosen.length > 1 ? "s" : ""} Selected` : "Select Items"}
          </Text>
          <Pressable accessibilityRole="button" disabled={!chosen.length || busyAction} hitSlop={12} onPress={onDelete}>
            <Text style={{ fontSize: 17, color: chosen.length ? C.flag : C.muted }}>Delete</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ position: "absolute", left: 16, right: 16, bottom: 32, flexDirection: "row", gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/jobs/[jobId]/camera", params: { jobId, jobNumber: jobNumber ?? "" } })}
            style={({ pressed }) => ({
              flex: 1,
              backgroundColor: C.brand,
              borderRadius: R.lg,
              overflow: "hidden",
              boxShadow: "0 10px 24px rgba(212,14,59,0.38)",
              transform: [{ scale: pressed ? 0.98 : 1 }],
            })}
          >
            <BrandGradient />
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 18 }}>
              <Icon name="camera" size={22} color="#fff" />
              <Text style={{ color: "#fff", fontWeight: "800", fontSize: 18 }}>Take Photos</Text>
            </View>
          </Pressable>
          {app.can("photos.import") ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add photos from your photo library"
              disabled={importing}
              onPress={addFromLibrary}
              style={({ pressed }) => [s.card, { borderRadius: R.lg, paddingVertical: 0, paddingHorizontal: 16, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", opacity: pressed || importing ? 0.6 : 1 }]}
            >
              <Icon name="image" size={20} color={C.text} />
              <Text style={{ color: C.text, fontWeight: "700", fontSize: 15 }}>{importing ? "Adding…" : "Library"}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** Small see-through button on the dark job band. */
function BandLink(props: { icon: "wrench" | "trash" | "sort"; label: string; onPress: () => void; highlight?: boolean; accessibilityLabel?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      hitSlop={6}
      onPress={props.onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 11,
        paddingVertical: 7,
        borderRadius: R.pill,
        backgroundColor: props.highlight ? "#b45309" : "rgba(255,255,255,0.12)",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name={props.icon} size={14} color="#fff" />
      <Text style={{ color: "#fff", fontWeight: "600", fontSize: 13.5 }}>{props.label}</Text>
    </Pressable>
  );
}
