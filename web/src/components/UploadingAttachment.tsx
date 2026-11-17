import * as React from 'react'
import { Icon } from './Icon'
import { useT } from '../i18n'
import { formatUploadBytes, type UploadProgress } from '../uploads'

export function UploadingAttachment({ name, loaded, total, saving, queued, onCancel }: UploadProgress & {
  name: string, queued: boolean, onCancel: () => void
}) {
  const t = useT()
  const percent = Math.min(100, Math.floor(loaded / Math.max(total, 1) * 100))
  const circumference = 2 * Math.PI * 22
  const status = queued ? t('composer.uploadQueued') : saving ? t('composer.uploadSaving') : percent + '%'
  return <span className="dsh-codex-attachment dsh-codex-attachment-card dsh-codex-upload-card"
    title={name + '\n' + formatUploadBytes(loaded) + ' / ' + formatUploadBytes(total) + ' · ' + status}>
    <span className="dsh-codex-upload-ring">
      <svg viewBox="0 0 56 56" role="progressbar" aria-label={t('composer.uploading') + ' ' + name}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={status}>
        <circle className="dsh-codex-upload-track" cx="28" cy="28" r="22" />
        <circle className="dsh-codex-upload-arc" cx="28" cy="28" r="22"
          strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} />
      </svg>
      <button type="button" className="dsh-codex-upload-cancel" aria-label={t('composer.cancelUpload') + ': ' + name}
        title={t('composer.cancelUpload')} onClick={onCancel}>
        <span className="dsh-codex-upload-value" aria-hidden="true">{percent}<small>%</small></span>
        <Icon name="close" size={18} className="dsh-codex-upload-cancel-icon" />
      </button>
    </span>
  </span>
}
