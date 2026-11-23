import React, { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { groupIssues } from "@rsb/photo-sync";
import { useApp } from "../src/state";
import { IssueCard, type ServerIssue } from "../src/issues";
import { C, DevBanner, Empty, s } from "../src/ui";

/**
 * Issues to fix. With a job: that job's Issues list, grouped (waiting for review, not assigned, being fixed, fixed).
 * Without a job: "To fix" for me (assigned to me), plus fixes waiting for my review if I'm a manager.
 */
export default function Issues() {
  const app = useApp();
  const { jobId, jobNumber } = useLocalSearchParams<{ jobId?: string; jobNumber?: string }>();
  const orgId = app.session?.orgId ?? "";
  const canReview = app.can("photo_issues.manage");
  const [lists, setLists] = useState<{ title: string; key: string; items: ServerIssue[] }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const cacheKey = jobId ? `job-issues-${jobId}` : "my-issues";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let next: { title: string; key: string; items: ServerIssue[] }[];
      if (jobId) {
        const r = await app.api.get<{ items: ServerIssue[] }>(`/v1/orgs/${orgId}/jobs/${jobId}/issues`);
        next = groupIssues(r.items);
      } else {
        const mine = await app.api.get<{ items: ServerIssue[] }>(`/v1/orgs/${orgId}/photo-issues?assigned=me&status=active`);
        next = [{ key: "mine", title: "Assigned to me", items: mine.items }];
        if (canReview) {
          const review = await app.api.get<{ items: ServerIssue[] }>(`/v1/orgs/${orgId}/photo-issues?status=awaiting_review`);
          next.push({ key: "review", title: "Fixes waiting for your review", items: review.items.filter((i) => i.can.approve) });
        }
        next = next.filter((g) => g.items.length > 0);
      }
      setLists(next);
      setOffline(false);
      await app.cache.put(cacheKey, next);
    } catch {
      setOffline(true);
      const cached = await app.cache.get<typeof lists>(cacheKey);
      setLists((cur) => cur ?? cached ?? []);
    } finally {
      setLoading(false);
    }
  }, [app.api, app.cache, orgId, jobId, canReview, cacheKey]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: jobId ? `Issues · ${jobNumber ?? "Job"}` : "To fix" }} />
      <DevBanner />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 48 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
        {offline ? <Text style={s.muted}>Offline: showing what was saved on this phone. Changing an issue needs a connection.</Text> : null}
        {lists && !lists.length ? <Empty title="Nothing to fix" body={jobId ? "No issues on this job." : "Nothing is assigned to you right now."} /> : null}
        {(lists ?? []).map((g) => (
          <View key={g.key} style={{ gap: 10 }}>
            <Text style={[s.label, { color: C.text }]}>{g.title} ({g.items.length})</Text>
            {g.items.map((i) => <IssueCard key={i.id} issue={i} onChanged={() => void load()} showPhotoLink />)}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
