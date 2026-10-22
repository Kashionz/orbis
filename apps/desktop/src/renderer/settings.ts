// 內建設定頁：第一次啟動時只顯示 Server URL，之後從選單開啟時也可以設定編輯器與終端機。

import { SETTINGS_API_KEY, type SettingsApi, type SettingsState } from "../settings-api";

const maybeApi = (window as unknown as Record<string, SettingsApi | undefined>)[SETTINGS_API_KEY];
if (!maybeApi) throw new Error("設定頁缺少 preload API");
const api: SettingsApi = maybeApi;

const $ = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`找不到 #${id}`);
  return element as T;
};

const firstRun = new URLSearchParams(location.search).has("first-run");

function fillPresets(select: HTMLSelectElement, state: SettingsState, kind: "editor" | "terminal") {
  const presets = kind === "editor" ? state.editorPresets : state.terminalPresets;
  select.replaceChildren(
    ...presets.map((preset) => {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      return option;
    }),
  );
  select.value = state[kind].preset;
}

function syncCustom(select: HTMLSelectElement, input: HTMLInputElement) {
  input.disabled = select.value !== "custom";
}

async function main() {
  const state = await api.getState();
  document.title = firstRun ? `連線到 ${state.productName}` : `${state.productName} 設定`;
  $("heading").textContent = document.title;

  const serverUrl = $<HTMLInputElement>("server-url");
  const serverError = $("server-error");
  const serverSave = $<HTMLButtonElement>("server-save");
  serverUrl.value = state.serverUrl ?? "";
  $<HTMLFormElement>("server-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    serverSave.disabled = true;
    serverError.textContent = "";
    const result = await api.saveServerUrl(serverUrl.value);
    serverSave.disabled = false;
    if (!result.ok) serverError.textContent = result.message;
  });

  if (firstRun) {
    serverUrl.focus();
    return;
  }

  const toolsForm = $<HTMLFormElement>("tools-form");
  toolsForm.hidden = false;
  $("placeholder-hint").textContent = state.pathPlaceholder;
  const editorPreset = $<HTMLSelectElement>("editor-preset");
  const editorCustom = $<HTMLInputElement>("editor-custom");
  const terminalPreset = $<HTMLSelectElement>("terminal-preset");
  const terminalCustom = $<HTMLInputElement>("terminal-custom");
  fillPresets(editorPreset, state, "editor");
  fillPresets(terminalPreset, state, "terminal");
  editorCustom.value = state.editor.customCommand;
  terminalCustom.value = state.terminal.customCommand;
  for (const [select, input] of [
    [editorPreset, editorCustom],
    [terminalPreset, terminalCustom],
  ] as const) {
    syncCustom(select, input);
    select.addEventListener("change", () => syncCustom(select, input));
  }

  const status = $("tools-status");
  toolsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api.saveTools({
      editor: { preset: editorPreset.value, customCommand: editorCustom.value },
      terminal: { preset: terminalPreset.value, customCommand: terminalCustom.value },
    });
    status.textContent = result.ok ? "已儲存" : result.message;
  });
}

void main();
