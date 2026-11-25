import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, TextInput, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { NetworkError } from "@rsb/photo-sync";
import { useApp, useQueueVersion, useSyncStatus, type Job } from "../../src/state";
import { BrandGradient, C, DevBanner, Empty, HeaderIcon, Icon, R, s } from "../../src/ui";
import { JobCard } from "../../src/JobCard";

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

  const syncTone = counts.needsAttention
    ? { fg: C.flag, bg: C.flagSoft, icon: "alert" as const }
    : counts.waiting
      ? { fg: C.warn, bg: C.warnSoft, icon: "cloudUp" as const }
      : { fg: C.ok, bg: C.okSoft, icon: "cloudCheck" as const };

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: "Jobs",
          headerRight: () => <HeaderIcon name="settings" label="Settings" onPress={() => router.push("/settings")} />,
        }}
      />
      <DevBanner />
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.fill, borderRadius: R.md, paddingHorizontal: 12 }}>
          <Icon name="search" size={18} color={C.muted} />
          <TextInput
            style={{ flex: 1, minHeight: 44, fontSize: 16, color: C.text }}
            value={q}
            onChangeText={setQ}
            placeholder="Search job number or name" placeholderTextColor={C.muted}
            autoCorrect={false}
            clearButtonMode="while-editing"
            accessibilityLabel="Search jobs"
          />
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/sync")}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: syncTone.bg, borderRadius: R.md, paddingHorizontal: 12, paddingVertical: 10, opacity: pressed ? 0.7 : 1 })}
        >
          <Icon name={syncTone.icon} size={18} color={syncTone.fg} />
          <Text style={{ flex: 1, fontWeight: "700", color: syncTone.fg }}>{syncText}</Text>
          <Icon name="chevronRight" size={16} color={syncTone.fg} />
        </Pressable>
        {note ? <Text style={s.muted}>{note}</Text> : null}
      </View>
      <FlatList
        data={shown}
        keyExtractor={(j) => j.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 110, gap: 10 }}
        ListEmptyComponent={
          loading ? undefined : <Empty icon={q ? "search" : "briefcase"} title={q ? "No matching jobs" : "No jobs yet"} body={q ? "Try a different job number or name." : app.can("jobs.manage") ? "Tap “New job” to add one." : "Ask a manager to assign you to a job."} />
        }
        renderItem={({ item }) => (
          <JobCard
            job={item}
            pending={pendingByJob.get(item.id) ?? 0}
            onPress={() => router.push({ pathname: "/jobs/[jobId]", params: { jobId: item.id, jobNumber: item.jobNumber, title: item.title } })}
          />
        )}
      />
      {app.can("jobs.manage") ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New job"
          onPress={() => router.push("/jobs/edit")}
          style={({ pressed }) => ({
            position: "absolute",
            right: 20,
            bottom: 36,
            borderRadius: R.pill,
            overflow: "hidden",
            backgroundColor: C.brand,
            boxShadow: "0 10px 24px rgba(212,14,59,0.4)",
            transform: [{ scale: pressed ? 0.96 : 1 }],
          })}
        >
          <BrandGradient />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 22, paddingVertical: 15 }}>
            <Icon name="plus" size={20} color="#fff" strokeWidth={2.5} />
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 16 }}>New job</Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}
