# Initial Grove design decisions

Historical rationale, condensed on 2026-09-06. Current behavior and operating
instructions live in the [documentation index](../README.md).

The initial design explored a common development environment for independent
projects and concurrent workers. These decisions explain the resulting scope:

- Keep the operating pattern separate from project values. A reusable skill
  describes the procedure; a project profile supplies commands and addressing.
- Share long-lived engines where appropriate. Changing catalog branding must
  not recreate existing engine containers or networks.
- Let each project choose its backend. Requiring Kubernetes, a particular
  gateway, or a machine proxy would exclude otherwise compatible projects.
- Separate hostname rendering from listening and routing. Printing an address
  does not establish that the application is reachable.
- Override only changed services while allowing the project's router to use
  its baseline for the rest. Workload creation and routing belong to adapters.
- Track lifecycle intent and observed completion separately. An accepted
  command is insufficient evidence of runtime identity or readiness.
- Keep one skill source and use load adapters instead of copying instructions
  into each agent tool's directory.

Proxy management, writer discovery, dashboards, and installers were explored as
possible extensions. This history does not make them supported features or an
approved backlog. The CLI help and current contracts define supported behavior.
