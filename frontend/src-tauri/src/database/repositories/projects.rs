use crate::database::models::ProjectModel;
use chrono::Utc;
use sqlx::{Error as SqlxError, SqlitePool};
use tracing::info;

pub struct ProjectsRepository;

impl ProjectsRepository {
    pub async fn list_projects(pool: &SqlitePool) -> Result<Vec<ProjectModel>, SqlxError> {
        let projects = sqlx::query_as::<_, ProjectModel>(
            "SELECT id, name, folder_path, created_at, updated_at \
             FROM projects ORDER BY name COLLATE NOCASE ASC",
        )
        .fetch_all(pool)
        .await?;
        Ok(projects)
    }

    pub async fn get_project(
        pool: &SqlitePool,
        project_id: &str,
    ) -> Result<Option<ProjectModel>, SqlxError> {
        if project_id.trim().is_empty() {
            return Err(SqlxError::Protocol("project_id cannot be empty".to_string()));
        }

        let project = sqlx::query_as::<_, ProjectModel>(
            "SELECT id, name, folder_path, created_at, updated_at \
             FROM projects WHERE id = ?",
        )
        .bind(project_id)
        .fetch_optional(pool)
        .await?;
        Ok(project)
    }

    pub async fn create_project(
        pool: &SqlitePool,
        id: &str,
        name: &str,
        folder_path: &str,
    ) -> Result<ProjectModel, SqlxError> {
        let name = name.trim();
        let folder_path = folder_path.trim();
        if name.is_empty() {
            return Err(SqlxError::Protocol(
                "project name cannot be empty".to_string(),
            ));
        }
        if folder_path.is_empty() {
            return Err(SqlxError::Protocol(
                "folder_path cannot be empty".to_string(),
            ));
        }

        let now = Utc::now().naive_utc();
        sqlx::query(
            "INSERT INTO projects (id, name, folder_path, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(name)
        .bind(folder_path)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;

        info!("Created project {} ({}) at {}", id, name, folder_path);

        Self::get_project(pool, id)
            .await?
            .ok_or_else(|| SqlxError::RowNotFound)
    }

    pub async fn update_project(
        pool: &SqlitePool,
        project_id: &str,
        name: Option<&str>,
        folder_path: Option<&str>,
    ) -> Result<Option<ProjectModel>, SqlxError> {
        if project_id.trim().is_empty() {
            return Err(SqlxError::Protocol("project_id cannot be empty".to_string()));
        }
        if name.is_none() && folder_path.is_none() {
            return Self::get_project(pool, project_id).await;
        }

        let now = Utc::now().naive_utc();
        let mut sql = String::from("UPDATE projects SET updated_at = ?");
        if name.is_some() {
            sql.push_str(", name = ?");
        }
        if folder_path.is_some() {
            sql.push_str(", folder_path = ?");
        }
        sql.push_str(" WHERE id = ?");

        let mut query = sqlx::query(&sql).bind(now);
        if let Some(n) = name {
            let trimmed = n.trim();
            if trimmed.is_empty() {
                return Err(SqlxError::Protocol(
                    "project name cannot be empty".to_string(),
                ));
            }
            query = query.bind(trimmed.to_string());
        }
        if let Some(f) = folder_path {
            let trimmed = f.trim();
            if trimmed.is_empty() {
                return Err(SqlxError::Protocol(
                    "folder_path cannot be empty".to_string(),
                ));
            }
            query = query.bind(trimmed.to_string());
        }
        query = query.bind(project_id);

        let result = query.execute(pool).await?;
        if result.rows_affected() == 0 {
            return Ok(None);
        }
        Self::get_project(pool, project_id).await
    }

    pub async fn delete_project(pool: &SqlitePool, project_id: &str) -> Result<bool, SqlxError> {
        if project_id.trim().is_empty() {
            return Err(SqlxError::Protocol("project_id cannot be empty".to_string()));
        }

        // SQLite foreign keys are not always enforced (PRAGMA foreign_keys is off by
        // default and the rest of this codebase deletes children explicitly), so we
        // clear meetings.project_id ourselves rather than relying on ON DELETE SET NULL.
        let mut tx = pool.begin().await?;

        sqlx::query("UPDATE meetings SET project_id = NULL WHERE project_id = ?")
            .bind(project_id)
            .execute(&mut *tx)
            .await?;

        let result = sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(project_id)
            .execute(&mut *tx)
            .await?;

        if result.rows_affected() == 0 {
            tx.rollback().await?;
            return Ok(false);
        }

        tx.commit().await?;
        info!("Deleted project {}", project_id);
        Ok(true)
    }

    pub async fn count_meetings(pool: &SqlitePool, project_id: &str) -> Result<i64, SqlxError> {
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM meetings WHERE project_id = ?")
            .bind(project_id)
            .fetch_one(pool)
            .await?;
        Ok(row.0)
    }
}

