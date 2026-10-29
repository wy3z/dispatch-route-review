"use client";

import { useRef } from "react";
import type { FormEvent } from "react";
import { createPortal } from "react-dom";
import { engineerRegions } from "@/modules/engineers/domain";
import { useDialogFocusManagement } from "../../shared/ui/useDialogFocusManagement";
import { weekDays } from "./engineer-draft";
import type { EngineerDraft } from "./engineer-draft";

type Props = {
  draft: EngineerDraft;
  saving: boolean;
  updateDraft: (patch: Partial<EngineerDraft>) => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
};

export function EngineerEditor({ draft, saving, updateDraft, onSave, onClose }: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const close = () => { if (!saving) onClose(); };
  useDialogFocusManagement(dialogRef, nameRef, close);

  return createPortal(
    <div
      className="engineers-editor-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="panel admin-panel engineers-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="engineers-editor-title"
      >
        <div className="admin-audit-heading">
          <div>
            <h2 id="engineers-editor-title">{draft.id ? `Edit ${draft.name}` : "Add engineer"}</h2>
            <p className="admin-panel-description">
              Autotask records are matched by resource ID. Existing resource IDs are fixed after creation.
            </p>
          </div>
        </div>
        <form onSubmit={onSave}>
          <div className="engineers-form-grid">
            <label>
              <span>Name</span>
              <input ref={nameRef} required maxLength={256} value={draft.name} onChange={(event) => updateDraft({ name: event.currentTarget.value })} />
            </label>
            <label>
              <span>Autotask resource ID</span>
              <input required type="number" min="1" step="1" value={draft.resourceId} disabled={Boolean(draft.id)} onChange={(event) => updateDraft({ resourceId: event.currentTarget.value })} />
            </label>
            <label>
              <span>Home base</span>
              <input required maxLength={256} value={draft.base} onChange={(event) => updateDraft({ base: event.currentTarget.value })} />
            </label>
            <label>
              <span>Region</span>
              <select value={draft.region} onChange={(event) => updateDraft({ region: event.currentTarget.value as EngineerDraft["region"] })}>
                {engineerRegions.map((region) => <option key={region}>{region}</option>)}
              </select>
            </label>
            <label>
              <span>Base latitude</span>
              <input required type="number" min="-90" max="90" step="any" value={draft.latitude} onChange={(event) => updateDraft({ latitude: event.currentTarget.value })} />
            </label>
            <label>
              <span>Base longitude</span>
              <input required type="number" min="-180" max="180" step="any" value={draft.longitude} onChange={(event) => updateDraft({ longitude: event.currentTarget.value })} />
            </label>
          </div>
          <fieldset className="engineers-working-days">
            <legend>Normal working days</legend>
            {weekDays.map((day) => (
              <label key={day.value}>
                <input
                  type="checkbox"
                  checked={draft.workingDays.includes(day.value)}
                  onChange={(event) => updateDraft({
                    workingDays: event.currentTarget.checked
                      ? [...draft.workingDays, day.value].sort()
                      : draft.workingDays.filter((value) => value !== day.value),
                  })}
                />
                <span>{day.label}</span>
              </label>
            ))}
          </fieldset>
          <div className="engineers-hours">
            <label>
              <span>Start time</span>
              <input required type="time" value={draft.workdayStart} onChange={(event) => updateDraft({ workdayStart: event.currentTarget.value })} />
            </label>
            <label>
              <span>End time</span>
              <input required type="time" value={draft.workdayEnd} onChange={(event) => updateDraft({ workdayEnd: event.currentTarget.value })} />
            </label>
          </div>
          <label className="engineers-aliases">
            <span>Also booked as</span>
            <input
              maxLength={1024}
              placeholder="Comma-separated names used on tickets without a resource ID"
              value={draft.aliasesText}
              onChange={(event) => updateDraft({ aliasesText: event.currentTarget.value })}
            />
            <small>Used only to match visits that have no Autotask resource ID.</small>
          </label>
          <div className="engineers-form-actions">
            <button type="button" className="admin-action" disabled={saving} onClick={close}>Cancel</button>
            <button type="submit" className="admin-action engineers-primary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}
