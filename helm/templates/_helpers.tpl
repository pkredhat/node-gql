{{- define "node-graphql-chart.fullname" -}}
{{- printf "%s" .Release.Name -}}
{{- end -}}

{{- define "node-graphql-chart.selectorLabels" -}}
app: {{ include "node-graphql-chart.fullname" . | quote }}
{{- end -}}

{{- define "node-graphql-chart.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}

{{- define "node-graphql-chart.postgresFullname" -}}
{{- printf "%s-postgres" (include "node-graphql-chart.fullname" .) -}}
{{- end -}}

{{- define "node-graphql-chart.mysqlFullname" -}}
{{- printf "%s-mysql" (include "node-graphql-chart.fullname" .) -}}
{{- end -}}

{{- define "node-graphql-chart.sqliteFullname" -}}
{{- printf "%s-sqlite" (include "node-graphql-chart.fullname" .) -}}
{{- end -}}

{{- define "node-graphql-chart.appFullname" -}}
{{- printf "%s-app" (include "node-graphql-chart.fullname" .) -}}
{{- end -}}

{{- define "node-graphql-chart.appEnv" -}}
- name: PORT
  value: {{ .Values.app.service.port | quote }}
- name: PGHOST
  value: {{ include "node-graphql-chart.postgresFullname" . | quote }}
- name: PGPORT
  value: {{ .Values.postgres.port | quote }}
- name: PGUSER
  valueFrom:
    secretKeyRef:
      name: {{ include "node-graphql-chart.postgresFullname" . }}
      key: POSTGRES_USER
- name: PGPASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "node-graphql-chart.postgresFullname" . }}
      key: POSTGRES_PASSWORD
- name: PGDATABASE
  valueFrom:
    secretKeyRef:
      name: {{ include "node-graphql-chart.postgresFullname" . }}
      key: POSTGRES_DB
- name: MYSQL_HOST
  value: {{ include "node-graphql-chart.mysqlFullname" . | quote }}
- name: MYSQL_PORT
  value: {{ .Values.mysql.port | quote }}
- name: MYSQL_USER
  valueFrom:
    secretKeyRef:
      name: {{ include "node-graphql-chart.mysqlFullname" . }}
      key: MYSQL_USER
- name: MYSQL_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "node-graphql-chart.mysqlFullname" . }}
      key: MYSQL_PASSWORD
- name: MYSQL_DATABASE
  valueFrom:
    secretKeyRef:
      name: {{ include "node-graphql-chart.mysqlFullname" . }}
      key: MYSQL_DATABASE
- name: SQLITE_MOUNT_PATH
  value: {{ .Values.sqlite.mountPath | quote }}
- name: SQLITE_DB_FILE
  value: {{ .Values.sqlite.dbFile | quote }}
{{- if .Values.app.env }}
{{- toYaml .Values.app.env | nindent 0 }}
{{- end }}
{{- end -}}

{{- define "node-graphql-chart.appImage" -}}
{{- if .Values.app.image -}}
{{- .Values.app.image -}}
{{- else -}}
{{- printf "image-registry.openshift-image-registry.svc:5000/%s/%s:%s" .Release.Namespace .Values.imageStream.name .Values.imageStream.tag -}}
{{- end -}}
{{- end -}}
