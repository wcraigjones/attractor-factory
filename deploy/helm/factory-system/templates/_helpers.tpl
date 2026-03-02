{{- define "factory.name" -}}
factory-system
{{- end -}}

{{- define "factory.namespace" -}}
{{- .Values.namespace -}}
{{- end -}}

{{- define "factory.labels" -}}
app.kubernetes.io/part-of: attractor-factory
app.kubernetes.io/managed-by: Helm
{{- end -}}

{{- define "factory.runnerImageRef" -}}
{{- $runner := .Values.images.runner -}}
{{- if $runner.digest -}}
{{- printf "%s@%s" $runner.repository $runner.digest -}}
{{- else -}}
{{- printf "%s:%s" $runner.repository $runner.tag -}}
{{- end -}}
{{- end -}}
