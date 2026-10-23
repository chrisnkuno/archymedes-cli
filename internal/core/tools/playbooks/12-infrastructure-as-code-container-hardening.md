## Infrastructure-as-code & container hardening

- **Containers running as root**: a Dockerfile with no `USER` directive (defaults to root), or one
  that switches to a non-root user and then does something requiring root afterward.
- **Overly permissive base images and layers**: a base image pinned to `latest` rather than a
  digest or version tag, or a build that copies the whole build context (`COPY . .` before
  `.dockerignore` excludes secrets/`.git`/`node_modules`).
- **Secrets baked into image layers**: a secret passed as a build `ARG` or copied in and then
  deleted in a later layer — it is still present in the earlier layer and extractable with
  `docker history`/`docker save`.
- **Cloud IAM over-permissioning**: a Terraform/CloudFormation/Pulumi resource attached to a policy
  using `*` for actions or resources where a scoped policy would do, or a role trusted by too broad
  a principal.
- **Public-by-default storage**: a storage bucket, database security group, or object-storage ACL
  with a public-read or public-write policy that looks unintentional (no obvious CDN/static-site
  purpose).
- **Missing network segmentation**: a database or internal service security group open to
  `0.0.0.0/0` rather than scoped to the app tier that actually needs to reach it.
- **Kubernetes**: a pod spec with `privileged: true`, `hostNetwork: true`, or no
  `resources.limits`/`securityContext` at all; a `Secret` mounted more broadly than the one
  container that needs it.

**How to check it**: read the Dockerfile/compose file/IaC top to bottom once — most of this
category is visible in a single pass, not something that needs deep tracing like the code-level
categories above.
