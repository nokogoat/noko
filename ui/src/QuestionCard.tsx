// Carte de questions à choix posées par Claude (outil AskUserQuestion) : cases à cocher
// (plusieurs réponses) ou boutons radio (une seule), plus « Autre » en texte libre.
// Texte brut uniquement.

import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango?version=1.0";
import { createComputed, createState } from "gnim";
import type { Question, QuestionAnswers, QuestionRequest } from "../../shared/protocol.ts";
import { answerQuestions, dismissQuestions } from "./actions.ts";
import { claimKeyboardOnClick } from "./keyboard.ts";
import { sessions } from "./store.ts";

/** Choix en cours pour une question. */
interface Choice {
  selected: Set<string>;
  otherChecked: boolean;
  otherText: string;
}

/** Réponse d'une question : libellés cochés (dans l'ordre), puis le texte libre. */
function answerOf(question: Question, choice: Choice): string {
  const parts = question.options.map((o) => o.label).filter((label) => choice.selected.has(label));
  const other = choice.otherText.trim();
  if (choice.otherChecked && other !== "") parts.push(other);
  return parts.join(", ");
}

function QuestionBlock({ question, choice, onChange }: { question: Question; choice: Choice; onChange: () => void }) {
  // Choix unique : tous les boutons du même groupe (radio).
  let leader: Gtk.CheckButton | null = null;
  const join = (button: Gtk.CheckButton) => {
    if (question.multiSelect) return;
    if (leader === null) leader = button;
    else button.set_group(leader);
  };
  let otherButton: Gtk.CheckButton;

  return (
    <Gtk.Box class="question" orientation={Gtk.Orientation.VERTICAL} spacing={4}>
      {question.header !== "" ? (
        <Gtk.Label class="question-header" label={question.header} useMarkup={false} xalign={0} />
      ) : null}
      <Gtk.Label class="question-text" label={question.question} useMarkup={false} wrap xalign={0} />
      <Gtk.Label
        class="question-hint"
        label={question.multiSelect ? "Plusieurs réponses possibles" : "Une seule réponse"}
        xalign={0}
      />
      {question.options.map((option) => (
        <Gtk.CheckButton
          class="option"
          $={join}
          onToggled={(button) => {
            if (button.active) choice.selected.add(option.label);
            else choice.selected.delete(option.label);
            onChange();
          }}
        >
          <Gtk.Box orientation={Gtk.Orientation.VERTICAL}>
            <Gtk.Label class="option-label" label={option.label} useMarkup={false} wrap xalign={0} />
            {option.description !== "" ? (
              <Gtk.Label
                class="option-description"
                label={option.description}
                useMarkup={false}
                wrap
                wrapMode={Pango.WrapMode.WORD_CHAR}
                xalign={0}
              />
            ) : null}
          </Gtk.Box>
        </Gtk.CheckButton>
      ))}
      <Gtk.Box spacing={6}>
        <Gtk.CheckButton
          class="option"
          label="Autre :"
          $={(button) => {
            otherButton = button;
            join(button);
          }}
          onToggled={(button) => {
            choice.otherChecked = button.active;
            onChange();
          }}
        />
        <Gtk.Entry
          hexpand
          placeholderText="Ta réponse"
          maxLength={2000}
          onChanged={(entry) => {
            choice.otherText = entry.text;
            if (entry.text !== "" && !otherButton.active) otherButton.active = true;
            onChange();
          }}
          $={claimKeyboardOnClick}
        />
      </Gtk.Box>
    </Gtk.Box>
  );
}

export function QuestionCard({ request }: { request: QuestionRequest }) {
  const choices: Choice[] = request.questions.map(() => ({
    selected: new Set<string>(),
    otherChecked: false,
    otherText: "",
  }));
  const [complete, setComplete] = createState(false);
  const [sent, setSent] = createState(false);
  const canAnswer = createComputed(() => complete() && !sent());
  const refresh = () => setComplete(request.questions.every((q, i) => answerOf(q, choices[i]!) !== ""));

  const submit = () => {
    if (!canAnswer.peek()) return;
    const answers: QuestionAnswers = {};
    request.questions.forEach((q, i) => {
      answers[q.question] = answerOf(q, choices[i]!);
    });
    // Désactivée jusqu'à la confirmation du daemon (question.resolved retire la carte).
    if (answerQuestions(request.requestId, answers)) setSent(true);
  };

  const sessionName = sessions.peek().find((s) => s.id === request.sessionId)?.name ?? "session";

  return (
    <Gtk.Box class="questions-card" orientation={Gtk.Orientation.VERTICAL} spacing={10}>
      <Gtk.Label class="permission-meta" label={`${sessionName} · Claude te pose une question`} xalign={0} />
      {request.questions.map((question, i) => (
        <QuestionBlock question={question} choice={choices[i]!} onChange={refresh} />
      ))}
      <Gtk.Box spacing={6} halign={Gtk.Align.END}>
        <Gtk.Button
          class="deny"
          label="Ignorer"
          sensitive={sent((s) => !s)}
          onClicked={() => {
            if (dismissQuestions(request.requestId)) setSent(true);
          }}
        />
        <Gtk.Button class="allow" label="Répondre" sensitive={canAnswer} onClicked={submit} />
      </Gtk.Box>
    </Gtk.Box>
  );
}
