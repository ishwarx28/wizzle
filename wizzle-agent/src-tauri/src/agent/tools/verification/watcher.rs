use std::{
    collections::BTreeSet,
    path::{Component, Path, PathBuf},
    sync::mpsc,
    time::Duration,
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

const EVENT_SETTLE_TIME: Duration = Duration::from_millis(300);
const MAX_WATCHED_DIRECTORIES: usize = 2_048;
const EXCLUDED_DIRECTORIES: &[&str] = &[
    ".dart_tool",
    ".git",
    ".gradle",
    ".idea",
    ".next",
    ".wizzle",
    ".xcode",
    "DerivedData",
    "Pods",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
];

pub struct ChangeTracker {
    receiver: mpsc::Receiver<notify::Result<Event>>,
    root: PathBuf,
    watched_directories: Vec<PathBuf>,
    watcher: Option<RecommendedWatcher>,
}

impl ChangeTracker {
    pub fn start(root: &Path) -> Result<Self, String> {
        let root = root.canonicalize().map_err(|error| {
            format!(
                "Could not resolve {} for change tracking: {error}",
                root.display()
            )
        })?;
        let (sender, receiver) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .map_err(|error| format!("Could not initialize change tracking: {error}"))?;
        let watched_directories = watch_source_directories(&mut watcher, &root)?;

        #[cfg(test)]
        ACTIVE_TRACKERS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        Ok(Self {
            receiver,
            root,
            watched_directories,
            watcher: Some(watcher),
        })
    }

    pub async fn finish(mut self) -> Vec<PathBuf> {
        tokio::time::sleep(EVENT_SETTLE_TIME).await;
        let mut paths = BTreeSet::new();
        while let Ok(event) = self.receiver.try_recv() {
            let Ok(event) = event else {
                continue;
            };
            if !is_mutation_event(&event.kind) {
                continue;
            }
            for path in event.paths {
                if !is_included_path(&self.root, &path) {
                    continue;
                }
                if path.is_dir() {
                    collect_existing_files(&self.root, &path, &mut paths);
                } else {
                    paths.insert(path);
                }
            }
        }
        self.stop();
        paths.into_iter().collect()
    }

    fn stop(&mut self) {
        let Some(mut watcher) = self.watcher.take() else {
            return;
        };
        for directory in self.watched_directories.drain(..) {
            let _ = watcher.unwatch(&directory);
        }
        drop(watcher);

        #[cfg(test)]
        ACTIVE_TRACKERS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Drop for ChangeTracker {
    fn drop(&mut self) {
        self.stop();
    }
}

fn is_mutation_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn watch_source_directories(
    watcher: &mut RecommendedWatcher,
    root: &Path,
) -> Result<Vec<PathBuf>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut watched = Vec::new();
    while let Some(directory) = pending.pop() {
        if watched.len() >= MAX_WATCHED_DIRECTORIES {
            return Err(format!(
                "Change tracking exceeded the limit of {MAX_WATCHED_DIRECTORIES} source directories."
            ));
        }
        watcher
            .watch(&directory, RecursiveMode::NonRecursive)
            .map_err(|error| format!("Could not watch {}: {error}", directory.display()))?;
        watched.push(directory.clone());
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() && !file_type.is_symlink() && is_included_path(root, &path) {
                pending.push(path);
            }
        }
    }
    Ok(watched)
}

fn collect_existing_files(root: &Path, directory: &Path, paths: &mut BTreeSet<PathBuf>) {
    let mut pending = vec![directory.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !is_included_path(root, &path) {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_file() {
                paths.insert(path);
            } else if file_type.is_dir() && !file_type.is_symlink() {
                pending.push(path);
            }
        }
    }
}

fn is_included_path(root: &Path, path: &Path) -> bool {
    if !path.starts_with(root) {
        return false;
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    !relative.components().any(|component| {
        let Component::Normal(value) = component else {
            return false;
        };
        let value = value.to_string_lossy();
        EXCLUDED_DIRECTORIES
            .iter()
            .any(|excluded| value.eq_ignore_ascii_case(excluded))
    })
}

#[cfg(test)]
static ACTIVE_TRACKERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, time::Duration};

    use super::{ChangeTracker, ACTIVE_TRACKERS};

    static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn temp_dir() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("wizzle-change-tracker-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test project");
        path
    }

    #[tokio::test]
    async fn reports_source_changes_and_releases_watcher() {
        let _guard = TEST_LOCK.lock().await;
        let root = temp_dir();
        let tracker = ChangeTracker::start(&root).expect("start watcher");
        assert_eq!(ACTIVE_TRACKERS.load(std::sync::atomic::Ordering::SeqCst), 1);
        let changed = root.canonicalize().expect("canonical root").join("lib.py");
        fs::write(&changed, "value = 1\n").expect("write source");
        tokio::time::sleep(Duration::from_millis(30)).await;

        let paths = tracker.finish().await;
        assert!(paths.contains(&changed));
        assert_eq!(ACTIVE_TRACKERS.load(std::sync::atomic::Ordering::SeqCst), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn drop_releases_watcher_after_early_exit() {
        let _guard = TEST_LOCK.lock().await;
        let root = temp_dir();
        let tracker = ChangeTracker::start(&root).expect("start watcher");
        assert_eq!(ACTIVE_TRACKERS.load(std::sync::atomic::Ordering::SeqCst), 1);
        drop(tracker);
        assert_eq!(ACTIVE_TRACKERS.load(std::sync::atomic::Ordering::SeqCst), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn excludes_generated_trees_and_collects_new_source_directories() {
        let _guard = TEST_LOCK.lock().await;
        let root = temp_dir();
        fs::create_dir_all(root.join("node_modules/package")).expect("create dependency tree");
        fs::create_dir_all(root.join("src")).expect("create source tree");
        let tracker = ChangeTracker::start(&root).expect("start watcher");
        assert!(tracker
            .watched_directories
            .iter()
            .all(|path| !path.to_string_lossy().contains("node_modules")));
        let generated = root.join("feature/main.dart");
        fs::create_dir_all(generated.parent().expect("feature parent"))
            .expect("create new source directory");
        fs::write(&generated, "void main() {}\n").expect("write generated source");

        let paths = tracker.finish().await;
        let canonical = root
            .canonicalize()
            .expect("canonical root")
            .join("feature/main.dart");
        assert!(paths.contains(&canonical));
        assert_eq!(ACTIVE_TRACKERS.load(std::sync::atomic::Ordering::SeqCst), 0);
        let _ = fs::remove_dir_all(root);
    }
}
