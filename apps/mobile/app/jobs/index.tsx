import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, TextInput, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { NetworkError } from "@rsb/photo-sync";
import { useApp, useQueueVersion, useSyncStatus, type Job } from "../../src/state";
import { C, DevBanner, Empty, s } from "../../src/ui";

function matches(j: Job, q: string): boolean {
  const n = q.trim().toLowerCase();
  if (!n) return true;
  return [j.jobNumber, j.title, j.siteName ?? ""].some((v) => v.toLowerCase().includes(n));
}

export default function Jobs() {
  const app = useApp();
  useQueueVersion();
  const sync = useSyncStatus();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await app.api.get<{ items: Job[] }>(`/v1/orgs/${app.session!.orgId}/jobs?limit=200`);
      setJobs(res.items);
      setNote(null);
      await app.cache.put("jobs", res.items);
    } catch (e) {
      const cached = (await app.cache.get<Job[]>("jobs")) ?? [];
      setJobs(cached);
      setNote(e instanceof NetworkError ? "Offline: showing the jobs saved on this phone." : "Couldn't refresh jobs. Showing saved list.");
    } finally {
      setLoading(false);
    }
  }, [app.api, app.cache, app.session]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    if (!app.session) router.replace("/login");
  }, [app.session]);

  const counts = app.queue.counts();
  const pendingByJob = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of app.queue.pending()) m.set(p.jobId, (m.get(p.jobId) ?? 0) + 1);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.queue, counts.waiting, counts.needsAttention]);

  const shown = jobs.filter((j) => matches(j, q));
  const syncText = counts.needsAttention
    ? `${counts.needsAttention} photo${counts.needsAttention > 1 ? "s" : ""} need attention`
    : counts.waiting
      ? sync.running
        ? `Uploading ${counts.waiting} photo${counts.waiting > 1 ? "s" : ""}…`
        : `${counts.waiting} photo${counts.waiting > 1 ? "s" : ""} waiting to upload${app.online ? "" : " (offline)"}`
      : "All photos uploaded";

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: "Jobs",
          headerRight: () => (
            <Pressable onPress={() => router.push("/settings")} hitSlop={12}>
              <Text style={{ color: C.brand, fontSize: 16 }}>Settings</Text>
            </Pressable>
          ),
        }}
      />
      <DevBanner />
      <Pressable
        onPress={() => router.push("/sync")}
        style={{ backgroundColor: counts.needsAttention ? C.flagSoft : counts.waiting ? C.warnSoft : C.okSoft, padding: 12 }}
      >
        <Text style={{ fontWeight: "600", color: counts.needsAttention ? C.flag : counts.waiting ? C.warn : C.ok }}>
          {syncText} ›
        </Text>
      </Pressable>
      <View style={{ padding: 16, paddingBottom: 8 }}>
        {app.session?.orgName ? <Text style={[s.muted, { marginBottom: 8 }]}>{app.session.orgName}</Text> : null}
        <TextInput
          style={s.input}
          value={q}
          onChangeText={setQ}
          placeholder="Search job number or name" placeholderTextColor={C.muted}
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {note ? <Text style={[s.muted, { marginTop: 8 }]}>{note}</Text> : null}
      </View>
      <FlatList
        data={shown}
        keyExtractor={(j) => j.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 100 }}
        ListEmptyComponent={
          loading ? undefined : <Empty title={q ? "No matching jobs" : "No jobs yet"} body={q ? "Try a different job number or name." : app.can("jobs.manage") ? "Tap “New job” to add one." : "Ask a manager to assign you to a job."} />
        }
        renderItem={({ item }) => {
          const pending = pendingByJob.get(item.id) ?? 0;
          return (
            <Pressable
              onPress={() => router.push({ pathname: "/jobs/[jobId]", params: { jobId: item.id, jobNumber: item.jobNumber, title: item.title } })}
              style={({ pressed }) => [s.card, { marginBottom: 10, opacity: pressed ? 0.7 : 1 }]}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 17, fontWeight: "700", color: C.text }}>{item.jobNumber}</Text>
                {pending ? <Text style={{ color: C.warn, fontWeight: "600" }}>{pending} to upload</Text> : null}
              </View>
              <Text style={{ fontSize: 15, color: C.text, marginTop: 2 }}>{item.title}</Text>
              {item.siteName ? <Text style={[s.muted, { marginTop: 2 }]}>{item.siteName}</Text> : null}
            </Pressable>
          );
        }}
      />
      {app.can("jobs.manage") ? (
        <Pressable
          onPress={() => router.push("/jobs/edit")}
          style={{ position: "absolute", right: 20, bottom: 36, backgroundColor: C.brand, borderRadius: 28, paddingHorizontal: 22, paddingVertical: 16 }}
        >
          <Text style={{ color: "#fff", fontWeight: "700", fontSize: 16 }}>+ New job</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
