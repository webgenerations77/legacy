"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppNav } from "@/components/AppNav";
import { LegacyMark } from "@/components/Logo";
import { api } from "@/lib/api-client";
import {
  type ObituaryIntake,
  type ObituaryTone,
  type ObituaryLength,
} from "@/lib/obituary";

const TONES: ObituaryTone[] = [
  "Traditional",
  "Warm",
  "Celebratory",
  "Faith-based",
];
const LENGTHS: ObituaryLength[] = ["Short", "Standard", "Long"];

const EMPTY: ObituaryIntake = {
  subjectName: "",
  dateOfBirth: "",
  dateOfDeath: "",
  placeOrHometown: "",
  lifeStory: "",
  family: "",
  achievements: "",
  hobbies: "",
  tone: "Warm",
  length: "Standard",
  additionalWishes: "",
};

export default function ObituaryPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [intake, setIntake] = useState<ObituaryIntake>(EMPTY);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .getObituary()
      .then((data) => {
        if (!active) return;
        if (data === null) {
          router.replace("/unlock");
          return;
        }
        if (data.obituary) {
          setIntake(data.obituary.intake);
          setDraft(data.obituary.draft);
        }
        setReady(true);
      })
      .catch(() => {
        if (!active) return;
        setError("We couldn't load your obituary.");
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, [router]);

  function set<K extends keyof ObituaryIntake>(
    key: K,
    value: ObituaryIntake[K],
  ) {
    setIntake((it) => ({ ...it, [key]: value }));
    setSaved(false);
  }

  async function onGenerate() {
    if (!intake.subjectName.trim()) {
      setError("Please enter a name first.");
      return;
    }
    setError(null);
    setSaved(false);
    setGenerating(true);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const res = await fetch("/api/obituary/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intake),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Generation failed. Please try again.");
      }
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      setDraft("");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setDraft((d) => d + chunk);
      }
      const tail = decoder.decode();
      if (tail) setDraft((d) => d + tail);
    } catch (e) {
      await reader?.cancel().catch(() => {});
      setError(e instanceof Error ? e.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  async function onSave() {
    if (!intake.subjectName.trim() || !draft.trim()) {
      setError("Add a name and generate a draft before saving.");
      return;
    }
    setError(null);
    try {
      await api.saveObituary(intake, draft);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't save your obituary.");
    }
  }

  if (!ready) return null;

  return (
    <main className="center">
      <div className="card">
        <AppNav />
        <div className="brand">
          <LegacyMark size={44} />
        </div>
        <h1>Obituary</h1>
        <p className="subtle">
          This obituary is saved as ordinary text so it can be shared — it is{" "}
          <strong>not</strong> stored in your encrypted vault.
        </p>

        <label htmlFor="subjectName">Name</label>
        <input
          id="subjectName"
          value={intake.subjectName}
          onChange={(e) => set("subjectName", e.target.value)}
        />

        <label htmlFor="dateOfBirth">Date of birth</label>
        <input
          id="dateOfBirth"
          value={intake.dateOfBirth}
          onChange={(e) => set("dateOfBirth", e.target.value)}
        />

        <label htmlFor="dateOfDeath">Date of death</label>
        <input
          id="dateOfDeath"
          value={intake.dateOfDeath}
          onChange={(e) => set("dateOfDeath", e.target.value)}
        />

        <label htmlFor="placeOrHometown">Place / hometown</label>
        <input
          id="placeOrHometown"
          value={intake.placeOrHometown}
          onChange={(e) => set("placeOrHometown", e.target.value)}
        />

        <label htmlFor="lifeStory">Life story</label>
        <textarea
          id="lifeStory"
          value={intake.lifeStory}
          onChange={(e) => set("lifeStory", e.target.value)}
        />

        <label htmlFor="family">Family (survived by)</label>
        <textarea
          id="family"
          value={intake.family}
          onChange={(e) => set("family", e.target.value)}
        />

        <label htmlFor="achievements">Achievements</label>
        <textarea
          id="achievements"
          value={intake.achievements}
          onChange={(e) => set("achievements", e.target.value)}
        />

        <label htmlFor="hobbies">Hobbies and interests</label>
        <textarea
          id="hobbies"
          value={intake.hobbies}
          onChange={(e) => set("hobbies", e.target.value)}
        />

        <label htmlFor="tone">Tone</label>
        <select
          id="tone"
          value={intake.tone}
          onChange={(e) => set("tone", e.target.value as ObituaryTone)}
        >
          {TONES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <label htmlFor="length">Length</label>
        <select
          id="length"
          value={intake.length}
          onChange={(e) => set("length", e.target.value as ObituaryLength)}
        >
          {LENGTHS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>

        <label htmlFor="additionalWishes">Anything else</label>
        <textarea
          id="additionalWishes"
          value={intake.additionalWishes}
          onChange={(e) => set("additionalWishes", e.target.value)}
        />

        <button type="button" onClick={onGenerate} disabled={generating}>
          {generating ? "Generating…" : draft ? "Regenerate" : "Generate"}
        </button>

        {error && <p className="error">{error}</p>}

        <label htmlFor="draft">Draft</label>
        <textarea
          id="draft"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(false);
          }}
          rows={14}
        />

        <button type="button" onClick={onSave} disabled={generating}>
          Save
        </button>
        {saved && <p className="subtle">Saved.</p>}
      </div>
    </main>
  );
}
