// Textes de l'interface, par langue. Le français sert de référence : chaque autre langue a
// exactement les mêmes clés (vérifié par le typage). Les textes venant de Claude ou des
// outils ne passent jamais par ici.
//
// Usage : `t((s) => s.composer.stop)` dans une propriété JSX (suit un changement de langue),
// `t()` dans un createComputed, `t.peek()` pour un texte ponctuel (erreur, résumé).

import GLib from "gi://GLib?version=2.0";
import type { ErrorCode, FileDiff, SessionStatus } from "../../shared/protocol.ts";
import { type Language, LANGUAGES } from "../../shared/config.ts";
import { config } from "./settings.ts";

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

const fr = {
  status: {
    starting: "démarrage",
    running: "en cours",
    idle: "en attente",
    stopped: "arrêtée",
    error: "erreur",
  } satisfies Record<SessionStatus, string>,
  activity: {
    thinking: "Réfléchit…",
    writing: "Écrit…",
    tool: (tool: string) => `Outil : ${tool}…`,
    permission: "Attend ton autorisation",
    question: "Te pose une question",
    compacting: "Compacte le contexte…",
    starting: "Démarrage…",
    working: "Travaille…",
  },
  usage: {
    context: (used: string, total: string, percent: number) => `Contexte ${used} / ${total} (${percent} %)`,
    contextOnly: (used: string) => `Contexte ${used}`,
    generated: (n: string) => `${n} générés`,
    tipContext: (n: number) => `Tokens dans le contexte : ${n}`,
    tipOutput: (n: number) => `Tokens générés par Claude (réflexion comprise) : ${n}`,
    tipCost: (usd: string) => `Coût estimé au tarif de l'API : ${usd} $ (pas une facture)`,
    tipSince: "Depuis le dernier démarrage ou la dernière reprise de la session.",
  },
  pill: {
    offline: "daemon absent",
    permission: (n: number) => (n > 1 ? `${n} autorisations` : "autorisation requise"),
    question: "question pour toi",
    noSession: "aucune session",
    /** État de la session la plus récente quand rien ne se passe. */
    rest: {
      starting: "démarrage",
      running: "en cours",
      idle: "à toi",
      stopped: "terminée",
      error: "erreur",
    } satisfies Record<SessionStatus, string>,
    tooltip: (cwd: string | null) =>
      `${cwd !== null ? `${cwd}\n` : ""}Cliquer pour ouvrir, glisser pour déplacer`,
  },
  notify: {
    done: (name: string) => `${name} : Claude a fini`,
    doneBody: "Ouvre noko pour voir la réponse et les modifications.",
    error: (name: string) => `${name} : session arrêtée sur une erreur`,
    permission: (name: string) => `${name} : autorisation demandée`,
    permissionBody: (tool: string) => `Claude veut utiliser ${tool}.`,
    question: (name: string) => `${name} : Claude te pose une question`,
    open: "Ouvrir",
  },
  header: {
    picker: "Session affichée (le menu permet de chercher)",
    terminalTag: "terminal",
    newSession: "Nouvelle session",
    collapse: "Réduire",
  },
  errors: {
    invalid_message: "Message refusé par le daemon.",
    unknown_session: "Session inconnue.",
    session_closed: "La session est terminée.",
    invalid_cwd: "Dossier introuvable.",
    not_resumable: "Cette session ne peut pas être reprise.",
    history_unavailable: "Historique indisponible.",
    unknown_request: "Demande expirée ou déjà traitée.",
    invalid_answers: "Réponds à toutes les questions.",
    terminal_session: "Session en cours dans un terminal : réponds-y depuis le terminal.",
    focus_unavailable: "Fenêtre du terminal introuvable.",
    internal: "Erreur interne du daemon.",
  } satisfies Record<ErrorCode, string>,
  composer: {
    noSession: "Aucune session sélectionnée",
    liveTerminal: "Session en cours dans un terminal",
    reply: "Répondre…",
    notResumable: "Session impossible à reprendre",
    resume: "Reprendre la session…",
    terminal: "Terminal",
    terminalTip: "Aller à la fenêtre du terminal",
    stop: "Arrêter",
    delete: "Supprimer",
    confirmDelete: "Confirmer ?",
    deleteTip: "Retirer de la liste (l'historique de Claude Code est conservé)",
    folderTip: "Dossier de la session",
    browseTip: "Choisir un autre dossier",
    namePlaceholder: "Nom (facultatif)",
    firstMessagePlaceholder: "Premier message (Ctrl+V pour une image)",
    cancel: "Annuler",
    create: "Créer",
    removeImage: "Retirer l'image",
    chooseFolder: "Choisis un dossier.",
    absolutePath: "Le dossier doit être un chemin absolu.",
    writeFirstMessage: "Écris un premier message.",
    addTextToImages: "Ajoute un message avec les images.",
    refused: "Message refusé (daemon absent ou champ invalide).",
    imagesAttached: (n: number) => `[${n} ${plural(n, "image jointe", "images jointes")}]`,
  },
  permission: {
    title: (tool: string) => `Claude veut utiliser ${tool}`,
    fromTerminal: "(terminal)",
    reason: (reason: string) => `Raison : ${reason}`,
    blockedPath: (path: string) => `Hors des dossiers autorisés : ${path}`,
    exactInput: "Entrée exacte",
    terminalDeadline: (s: number) => `Sinon, le terminal demandera dans ${s} s`,
    denyDeadline: (min: number) => `Refus automatique dans ${min} min`,
    deny: "Refuser",
    allow: "Autoriser",
  },
  question: {
    multi: "Plusieurs réponses possibles",
    single: "Une seule réponse",
    other: "Autre :",
    otherPlaceholder: "Ta réponse",
    asks: "Claude te pose une question",
    dismiss: "Ignorer",
    answer: "Répondre",
  },
  diff: {
    kind: {
      edit: "Modification",
      create: "Nouveau fichier",
      overwrite: "Fichier réécrit",
      write: "Contenu écrit",
    } satisfies Record<FileDiff["kind"], string>,
    incomplete: "(incomplet)",
    line: (n: number) => `ligne ${n}`,
    noChange: "Aucun changement",
    truncated: "Diff trop long, coupé : seule l'entrée exacte fait foi.",
  },
  attachment: {
    tooMany: (max: number) => `${max} images au maximum par message.`,
    tooLarge: "Image trop grande ou illisible.",
    unreadable: "Image illisible.",
    inaccessible: "Fichier inaccessible.",
    notImage: "Ce fichier n'est pas une image lisible.",
    clipboardImage: "Image du presse-papiers illisible.",
    clipboardFiles: "Fichiers du presse-papiers illisibles.",
  },
};

export type Strings = typeof fr;

const en: Strings = {
  status: {
    starting: "starting",
    running: "running",
    idle: "waiting",
    stopped: "stopped",
    error: "error",
  },
  activity: {
    thinking: "Thinking…",
    writing: "Writing…",
    tool: (tool) => `Tool: ${tool}…`,
    permission: "Waiting for your approval",
    question: "Asking you a question",
    compacting: "Compacting context…",
    starting: "Starting…",
    working: "Working…",
  },
  usage: {
    context: (used, total, percent) => `Context ${used} / ${total} (${percent}%)`,
    contextOnly: (used) => `Context ${used}`,
    generated: (n) => `${n} generated`,
    tipContext: (n) => `Tokens in context: ${n}`,
    tipOutput: (n) => `Tokens generated by Claude (thinking included): ${n}`,
    tipCost: (usd) => `Estimated cost at API rates: $${usd} (not a bill)`,
    tipSince: "Since the session was last started or resumed.",
  },
  pill: {
    offline: "daemon offline",
    permission: (n) => (n > 1 ? `${n} approvals` : "approval needed"),
    question: "question for you",
    noSession: "no session",
    rest: {
      starting: "starting",
      running: "running",
      idle: "your turn",
      stopped: "finished",
      error: "error",
    },
    tooltip: (cwd) => `${cwd !== null ? `${cwd}\n` : ""}Click to open, drag to move`,
  },
  notify: {
    done: (name) => `${name}: Claude is done`,
    doneBody: "Open noko to see the answer and the changes.",
    error: (name) => `${name}: session stopped on an error`,
    permission: (name) => `${name}: approval needed`,
    permissionBody: (tool) => `Claude wants to use ${tool}.`,
    question: (name) => `${name}: Claude is asking you a question`,
    open: "Open",
  },
  header: {
    picker: "Shown session (the menu is searchable)",
    terminalTag: "terminal",
    newSession: "New session",
    collapse: "Collapse",
  },
  errors: {
    invalid_message: "Message rejected by the daemon.",
    unknown_session: "Unknown session.",
    session_closed: "The session has ended.",
    invalid_cwd: "Folder not found.",
    not_resumable: "This session cannot be resumed.",
    history_unavailable: "History unavailable.",
    unknown_request: "Request expired or already handled.",
    invalid_answers: "Answer every question.",
    terminal_session: "Session running in a terminal: reply from the terminal.",
    focus_unavailable: "Terminal window not found.",
    internal: "Internal daemon error.",
  },
  composer: {
    noSession: "No session selected",
    liveTerminal: "Session running in a terminal",
    reply: "Reply…",
    notResumable: "Session cannot be resumed",
    resume: "Resume the session…",
    terminal: "Terminal",
    terminalTip: "Go to the terminal window",
    stop: "Stop",
    delete: "Delete",
    confirmDelete: "Confirm?",
    deleteTip: "Remove from the list (Claude Code's history is kept)",
    folderTip: "Session folder",
    browseTip: "Pick another folder",
    namePlaceholder: "Name (optional)",
    firstMessagePlaceholder: "First message (Ctrl+V for an image)",
    cancel: "Cancel",
    create: "Create",
    removeImage: "Remove image",
    chooseFolder: "Pick a folder.",
    absolutePath: "The folder must be an absolute path.",
    writeFirstMessage: "Write a first message.",
    addTextToImages: "Add a message with the images.",
    refused: "Message rejected (daemon offline or invalid field).",
    imagesAttached: (n) => `[${n} ${plural(n, "image attached", "images attached")}]`,
  },
  permission: {
    title: (tool) => `Claude wants to use ${tool}`,
    fromTerminal: "(terminal)",
    reason: (reason) => `Reason: ${reason}`,
    blockedPath: (path) => `Outside the allowed folders: ${path}`,
    exactInput: "Exact input",
    terminalDeadline: (s) => `Otherwise the terminal will ask in ${s} s`,
    denyDeadline: (min) => `Automatically denied in ${min} min`,
    deny: "Deny",
    allow: "Allow",
  },
  question: {
    multi: "Several answers allowed",
    single: "One answer",
    other: "Other:",
    otherPlaceholder: "Your answer",
    asks: "Claude is asking you a question",
    dismiss: "Dismiss",
    answer: "Answer",
  },
  diff: {
    kind: {
      edit: "Edit",
      create: "New file",
      overwrite: "File rewritten",
      write: "Content written",
    },
    incomplete: "(incomplete)",
    line: (n) => `line ${n}`,
    noChange: "No change",
    truncated: "Diff too long, cut: only the exact input is authoritative.",
  },
  attachment: {
    tooMany: (max) => `At most ${max} images per message.`,
    tooLarge: "Image too large or unreadable.",
    unreadable: "Unreadable image.",
    inaccessible: "File not accessible.",
    notImage: "This file is not a readable image.",
    clipboardImage: "Unreadable clipboard image.",
    clipboardFiles: "Unreadable clipboard files.",
  },
};

const DICTIONARIES: Record<Language, Strings> = { fr, en };

/** Langue du système (LANGUAGE, LC_ALL, LC_MESSAGES, LANG), si elle est traduite. */
function systemLanguage(): Language {
  for (const name of GLib.get_language_names()) {
    const code = name.slice(0, 2).toLowerCase();
    if ((LANGUAGES as readonly string[]).includes(code)) return code as Language;
  }
  return "en";
}

const SYSTEM = systemLanguage();

/** Textes de la langue choisie dans la config ; suit ses changements à chaud. */
export const t = config((c) => DICTIONARIES[c.general.language === "auto" ? SYSTEM : c.general.language]);
