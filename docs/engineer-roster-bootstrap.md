# Engineer roster setup

Migration `009_engineer_roster.sql` creates the schema only.
Keep tenant names, resource IDs, base locations, and coordinates out of source-controlled files, fixtures, env files, images, and deployment logs.

## Load the roster

1. Obtain the roster data owner's approval for the roster source and transfer method.
2. Keep the approval in the controlled change record, outside Git.
3. Check each base location before entry.
   Prefer a depot, office, or approximate city-center point.
   Residential or more precise coordinates require data-owner approval and a recorded operational need.
4. Grant `engineer_management` to the designated roster manager through Entra sign-in.
   Do not grant admin access only to load the roster.
5. Create records from the approved source through `/engineers`.
6. Check immutable Autotask resource IDs and active/inactive states against the source.
7. Check the audit events.

Use `/engineers` for later changes. Creation records `engineer.created`; updates record `engineer.updated`.
Removal records `engineer.deactivated` and keeps historical assignment resolution.
The API uses transactions and invalidates dependent snapshots for worker refresh.

If the source is unavailable, stop setup. Obtain an approved secure transfer method.
Do not create an unapproved SQL/JSON export or source-controlled seed.
