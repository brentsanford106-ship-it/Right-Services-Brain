import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { ApiError, NetworkError } from "@rsb/photo-sync";
import { useApp, type Job } from "../../src/state";
import { Button, C, Chip, JOB_STATUSES, s } from "../../src/ui";

/** Create a job, or edit one when opened with ?jobId=. Needs a connection (jobs are created on the server). */
export default function EditJob() {
  const app = useApp();
  const { jobId } = useLocalSearchParams<{ jobId?: string }>();
  const [jobNumber, setJobNumber] = useState("");
  const [title, setTitle] = useState("");
  const [siteName, setSiteName] = useState("");
  const [siteAddress, setSiteAddress] = useState("");
  const [status, setStatus] = useState("active");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/v1/orgs/${app.session!.orgId}`;

  useEffect(() => {
    if (!jobId) return;
    app.api
      .get<Job>(`${base}/jobs/${jobId}`)
      .then((j) => {
        setJobNumber(j.jobNumber);
        setTitle(j.title);
        setSiteName(j.siteName ?? "");
        setSiteAddress(j.siteAddress ?? "");
        setStatus(j.status);
      })
      .catch(() => setError("Couldn't load the job. Editing needs a connection."));
  }, [jobId, app.api, base]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (jobId) {
        await app.api.patch(`${base}/jobs/${jobId}`, { title: title.trim(), siteName: siteName.trim() || null, siteAddress: siteAddress.trim() || null, status });
        router.back();
      } else {
        const j = await app.api.post<Job>(`${base}/jobs`, {
          jobNumber: jobNumber.trim(),
          title: title.trim(),
          status,
          ...(siteName.trim() ? { siteName: siteName.trim() } : {}),
          ...(siteAddress.trim() ? { siteAddress: siteAddress.trim() } : {}),
        });
        router.replace({ pathname: "/jobs/[jobId]", params: { jobId: j.id, jobNumber: j.jobNumber, title: j.title } });
      }
    } catch (e) {
      if (e instanceof NetworkError) setError("No connection. Creating or editing a job needs a connection.");
      else if (e instanceof ApiError && e.status === 409) setError("That job number is already used.");
      else if (e instanceof ApiError && e.status === 400) setError("Check the fields: job number can use letters, numbers, - and _ only.");
      else setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen options={{ title: jobId ? "Edit job" : "New job" }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
        <View>
          <Text style={s.label}>Job number</Text>
          <TextInput style={[s.input, jobId ? { opacity: 0.6 } : null]} editable={!jobId} value={jobNumber} onChangeText={setJobNumber} autoCapitalize="characters" autoCorrect={false} placeholder="HP-1004" placeholderTextColor={C.muted} />
        </View>
        <View>
          <Text style={s.label}>Job name</Text>
          <TextInput style={s.input} value={title} onChangeText={setTitle} placeholder="Canopy light replacement" placeholderTextColor={C.muted} />
        </View>
        <View>
          <Text style={s.label}>Site name (optional)</Text>
          <TextInput style={s.input} value={siteName} onChangeText={setSiteName} placeholder="Station 12" placeholderTextColor={C.muted} />
        </View>
        <View>
          <Text style={s.label}>Site address (optional)</Text>
          <TextInput style={s.input} value={siteAddress} onChangeText={setSiteAddress} placeholder="Street, city" placeholderTextColor={C.muted} />
        </View>
        <View>
          <Text style={s.label}>Status</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {JOB_STATUSES.map((st) => (
              <Chip key={st.value} label={st.label} active={status === st.value} onPress={() => setStatus(st.value)} />
            ))}
          </View>
        </View>
        {error ? <Text style={s.error}>{error}</Text> : null}
        <Button title={jobId ? "Save changes" : "Create job"} busy={busy} disabled={!title.trim() || (!jobId && !jobNumber.trim())} onPress={() => void save()} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
