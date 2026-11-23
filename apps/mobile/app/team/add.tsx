import React, { useEffect, useState } from "react";
import { Alert, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, router } from "expo-router";
import { useApp } from "../../src/state";
import { Button, C, DevBanner, s } from "../../src/ui";
import { CheckRow, errorText, holds, type TeamRole } from "../../src/team";

/**
 * Add a person by email. Nothing is sent to them: they open the app, tap Sign in, and use this
 * email address. Microsoft checks the address with a one-time code, then they get these roles.
 */
export default function AddPerson() {
  const app = useApp();
  const base = `/v1/orgs/${app.session!.orgId}`;
  const [roles, setRoles] = useState<TeamRole[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await app.api.get<{ items: TeamRole[] }>(`${base}/team/roles`);
        setRoles(r.items);
        const employee = r.items.find((x) => x.key === "employee");
        if (employee) setPicked(new Set([employee.id]));
      } catch (e) {
        setNote(errorText(e));
      }
    })();
  }, [app.api, base]);

  const ready = name.trim().length > 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) && picked.size > 0;

  const add = async () => {
    setBusy(true);
    try {
      await app.api.post(`${base}/team/invites`, {
        email: email.trim(),
        displayName: name.trim(),
        ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
        roleIds: [...picked],
      });
      Alert.alert("Added", `Tell ${name.trim()} to open the app, tap Sign in, and use ${email.trim()}.`);
      router.back();
    } catch (e) {
      Alert.alert("Not added", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: "Add Person" }} />
      <DevBanner />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 10 }} keyboardShouldPersistTaps="handled">
        {note ? <Text style={s.error}>{note}</Text> : null}
        <Text style={s.muted}>They'll sign in with this email address (Microsoft sends them a code; no password is needed), then press Accept to join. They have 14 days to accept.</Text>
        <Text style={[s.label, { marginTop: 8 }]}>Name</Text>
        <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Full name" placeholderTextColor={C.muted} />
        <Text style={s.label}>Email</Text>
        <TextInput
          style={s.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          placeholder="name@example.com"
          placeholderTextColor={C.muted}
        />
        <Text style={s.label}>Job title (optional)</Text>
        <TextInput style={s.input} value={jobTitle} onChangeText={setJobTitle} placeholder="Technician" placeholderTextColor={C.muted} />
        <Text style={[s.label, { marginTop: 8 }]}>ROLES</Text>
        <View style={[s.card, { paddingVertical: 0 }]}>
          {roles.map((r) => {
            const allowed = r.permissions.every((p) => holds(app.can, p));
            return (
              <CheckRow
                key={r.id}
                label={r.name}
                sub={allowed ? (r.locked ? "Everything" : `${r.permissions.length} permissions`) : "Has permissions you don't have, so you can't give it"}
                checked={picked.has(r.id)}
                disabled={!allowed || busy}
                onToggle={() =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    return next;
                  })
                }
              />
            );
          })}
        </View>
        <Button title="Add Person" onPress={() => void add()} disabled={!ready} busy={busy} style={{ marginTop: 8 }} />
      </ScrollView>
    </View>
  );
}
