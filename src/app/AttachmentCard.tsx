import { useEffect, useRef, useState } from 'react';
import { styled } from 'styled-components';
import { Anchor, Button } from '@zendeskgarden/react-buttons';
import { Field, Select } from '@zendeskgarden/react-forms';
import { Progress } from '@zendeskgarden/react-loaders';
import { Alert } from '@zendeskgarden/react-notifications';
import { MD, SM } from '@zendeskgarden/react-typography';
import { errorOf, isAbort, type ApiError, type ConverterApi } from '../api';
import { formatBytes, viewUrl, type Catalog } from '../catalog';
import { SignInRequired, convertFile, convertLink, type Result, type Step } from '../convert';
import type { TicketAttachment } from '../zendesk';
import { color } from './color';

type Phase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'working'; readonly step: Step | null }
  | { readonly phase: 'done'; readonly result: Result }
  | { readonly phase: 'failed'; readonly error: ApiError };

export interface AttachmentCardProps {
  readonly attachment: TicketAttachment;
  readonly catalog: Catalog;
  readonly api: ConverterApi;
  /** The most credits one conversion may use (the admin's setting). */
  readonly limit: number;
  /** The account's attachment links need a sign-in: the agent chooses the saved file. */
  readonly signIn: boolean;
  readonly onConverted?: (credits: number) => void;
}

export function AttachmentCard({
  attachment,
  catalog,
  api,
  limit,
  signIn,
  onConverted,
}: AttachmentCardProps) {
  const format = catalog.formatOf(attachment);
  const targets = catalog.targets(format);
  const [key, setKey] = useState(targets[0]?.key ?? '');
  const [phase, setPhase] = useState<Phase>({ phase: 'idle' });
  const [mode, setMode] = useState<'link' | 'file'>(signIn ? 'file' : 'link');
  const [file, setFile] = useState<File | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const cancel = useRef<{ canceled: boolean; controller: AbortController } | null>(null);
  useEffect(() => () => cancel.current?.controller.abort(), []);

  const target = targets.find((t) => t.key === key) ?? targets[0];
  const working = phase.phase === 'working';
  const id = `cvs-${attachment.id}`;

  async function run() {
    if (!target || !format) return;
    if (mode === 'file' && !file) return;
    const attempt = { canceled: false, controller: new AbortController() };
    cancel.current = attempt;
    setPhase({ phase: 'working', step: null });
    const hooks = {
      onStep: (step: Step) => {
        if (!attempt.canceled) setPhase({ phase: 'working', step });
      },
      canceled: () => attempt.canceled,
      signal: attempt.controller.signal,
    };
    try {
      const result =
        mode === 'file' && file
          ? await convertFile(
              api,
              { file, name: file.name, to: target.to, options: target.options },
              limit,
              hooks,
            )
          : await convertLink(
              api,
              { url: attachment.url, expected: format.id, to: target.to, options: target.options },
              limit,
              hooks,
            );
      if (attempt.canceled) return;
      setPhase({ phase: 'done', result });
      onConverted?.(result.credits);
    } catch (error) {
      if (attempt.canceled || isAbort(error)) {
        setPhase({ phase: 'idle' });
        return;
      }
      if (error instanceof SignInRequired) setMode('file');
      setPhase({ phase: 'failed', error: errorOf(error) });
    } finally {
      if (cancel.current === attempt) cancel.current = null;
    }
  }

  function stop() {
    const attempt = cancel.current;
    if (!attempt) return;
    attempt.canceled = true;
    attempt.controller.abort();
    setPhase({ phase: 'idle' });
  }

  return (
    <Card aria-labelledby={`${id}-name`}>
      <div>
        <Name id={`${id}-name`} isBold title={attachment.name}>
          {attachment.name}
        </Name>
        <Muted>
          {[
            attachment.size ? formatBytes(attachment.size) : null,
            format?.name,
            attachment.isPublic ? null : 'internal note',
            attachment.inline ? 'inline image' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Muted>
      </div>

      <Field>
        <Field.Label isRegular>Convert to</Field.Label>
        <Select
          isCompact
          value={target?.key ?? ''}
          disabled={working}
          onChange={(event) => {
            setKey(event.target.value);
            if (phase.phase !== 'working') setPhase({ phase: 'idle' });
          }}
        >
          {targets.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </Select>
      </Field>

      {mode === 'file' && (
        <FileRow>
          <input
            ref={picker}
            type="file"
            hidden
            accept={format ? format.extensions.map((e) => `.${e}`).join(',') : undefined}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              if (phase.phase !== 'working') setPhase({ phase: 'idle' });
            }}
          />
          <Button size="small" disabled={working} onClick={() => picker.current?.click()}>
            {file ? 'Choose another file' : 'Choose the saved file'}
          </Button>
          <Muted>
            {file ? (
              <>
                {file.name} · {formatBytes(file.size)}
              </>
            ) : (
              <>
                Save it first:{' '}
                <Anchor href={attachment.url} isExternal externalIconLabel="(opens in a new tab)">
                  open the attachment
                </Anchor>
              </>
            )}
          </Muted>
        </FileRow>
      )}

      {working ? (
        <Working>
          <Progress
            size="small"
            value={progressOf(phase.step)}
            aria-label="Conversion progress"
            aria-valuetext={statusText(phase.step)}
          />
          <Row>
            <SM aria-live="polite">{statusText(phase.step)}</SM>
            {cancellable(phase.step) && (
              <Button size="small" isBasic onClick={stop}>
                Cancel
              </Button>
            )}
          </Row>
        </Working>
      ) : (
        <Button
          size="small"
          isPrimary
          disabled={!target || (mode === 'file' && !file)}
          onClick={() => void run()}
        >
          {phase.phase === 'done' ? 'Convert again' : 'Convert'}
        </Button>
      )}

      {phase.phase === 'done' && <Done result={phase.result} />}
      {phase.phase === 'failed' && (
        <Alert type={phase.error.code === 'signInRequired' ? 'info' : 'error'}>
          <Alert.Paragraph>{phase.error.message}</Alert.Paragraph>
          {mode === 'link' && LINK_FAILURES.has(phase.error.code) && (
            <Alert.Paragraph>
              <Button isLink onClick={() => setMode('file')}>
                Choose the file from your computer instead
              </Button>
            </Alert.Paragraph>
          )}
        </Alert>
      )}
    </Card>
  );
}

/** Link failures where choosing the saved file may work instead. */
const LINK_FAILURES = new Set(['remoteFailed', 'remoteUnsupported', 'invalidUrl', 'timeout']);

function Done({ result }: { readonly result: Result }) {
  const view = viewUrl(result.downloadUrl, result.to, result.outputName);
  return (
    <Result role="status">
      <SM>
        <strong>{result.outputName}</strong> · {formatBytes(result.size)} · {result.credits} credit
        {result.credits === 1 ? '' : 's'}
      </SM>
      <Links>
        <Anchor href={result.downloadUrl} target="_blank" rel="noopener noreferrer">
          Download
        </Anchor>
        {view && (
          <Anchor href={view} isExternal externalIconLabel="(opens in a new tab)">
            Open
          </Anchor>
        )}
      </Links>
      <Muted>
        The link works for 6 hours. To keep the file on the ticket, attach the download to a reply
        or an internal note.
      </Muted>
    </Result>
  );
}

function statusText(step: Step | null): string {
  if (!step) return 'Starting…';
  if (step.step === 'uploading') {
    const percent = step.total ? Math.floor((step.sent / step.total) * 100) : 0;
    return `Sending the file… ${percent}%`;
  }
  switch (step.status) {
    case 'fetching':
      return 'Converter Studio is fetching the file from Zendesk…';
    case 'waiting_for_upload':
    case 'measuring':
      return 'Checking the file…';
    case 'quoted':
      return 'Checking the price…';
    case 'queued':
      return 'Waiting for a converter…';
    case 'processing':
      return step.progress === null ? 'Converting…' : `Converting… ${Math.round(step.progress)}%`;
    default:
      return 'Finishing…';
  }
}

function progressOf(step: Step | null): number {
  if (!step) return 2;
  if (step.step === 'uploading') return step.total ? (step.sent / step.total) * 30 : 0;
  if (step.status === 'processing' && step.progress !== null)
    return 40 + Math.min(100, Math.max(0, step.progress)) * 0.6;
  return step.status === 'queued' || step.status === 'processing' ? 40 : 20;
}

/** Stopping is free until the conversion has been paid for and started. */
function cancellable(step: Step | null): boolean {
  if (!step || step.step === 'uploading') return true;
  return step.status === 'fetching' || step.status === 'measuring' || step.status === 'quoted';
}

const Card = styled.section`
  display: flex;
  flex-direction: column;
  gap: ${(p) => p.theme.space.xs};
  border: ${(p) => p.theme.borders.sm} ${(p) => color(p.theme, 'border.default')};
  border-radius: ${(p) => p.theme.borderRadii.md};
  padding: ${(p) => p.theme.space.sm};
`;

const Name = styled(MD)`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${(p) => p.theme.space.sm};
`;

const Links = styled.div`
  display: flex;
  align-items: center;
  gap: ${(p) => p.theme.space.md};
`;

const FileRow = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: ${(p) => p.theme.space.xxs};
`;

const Working = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${(p) => p.theme.space.xxs};
`;

const Result = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${(p) => p.theme.space.xxs};
`;

const Muted = styled(SM)`
  color: ${(p) => color(p.theme, 'foreground.subtle')};
`;
