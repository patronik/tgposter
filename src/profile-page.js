let currentProfile = null;

async function loadProfile() {
  const statusEl = document.getElementById('profile-status');
  const photoEl = document.getElementById('profile-photo');
  const placeholderEl = document.getElementById('profile-photo-placeholder');
  const usernameEl = document.getElementById('profile-username');
  const bioEl = document.getElementById('profile-bio');
  const updateBtn = document.getElementById('update-profile-btn');

  try {
    currentProfile = await window.api.getProfile();
  } catch (e) {
    statusEl.textContent = 'Помилка завантаження: ' + (e.message || e);
    currentProfile = { loggedIn: false, phone: '', username: '', bio: '', hasPhoto: false };
  }

  if (!currentProfile.loggedIn) {
    statusEl.textContent = 'Акаунт не ввійшов. Дані профілю порожні.';
    usernameEl.value = '';
    bioEl.value = '';
    photoEl.style.display = 'none';
    placeholderEl.style.display = 'flex';
    updateBtn.disabled = true;
    return;
  }

  statusEl.textContent = 'Активний акаунт: ' + (currentProfile.phone || '—');
  usernameEl.value = currentProfile.username || '';
  bioEl.value = currentProfile.bio || '';

  if (currentProfile.hasPhoto) {
    photoEl.src = window.api.getProfilePhotoUrl();
    photoEl.style.display = 'block';
    placeholderEl.style.display = 'none';
    photoEl.onerror = () => {
      photoEl.style.display = 'none';
      placeholderEl.style.display = 'flex';
    };
  } else {
    photoEl.style.display = 'none';
    placeholderEl.style.display = 'flex';
  }

  updateBtn.disabled = false;
}

async function updateProfile() {
  const usernameEl = document.getElementById('profile-username');
  const bioEl = document.getElementById('profile-bio');
  const updateBtn = document.getElementById('update-profile-btn');
  const statusEl = document.getElementById('profile-status');

  const username = (usernameEl.value || '').trim().replace(/^@/, '');
  const bio = (bioEl.value || '').trim();

  updateBtn.disabled = true;
  statusEl.textContent = 'Оновлення…';

  try {
    await window.api.updateProfile({ username, bio });
    statusEl.textContent = 'Профіль оновлено. Активний акаунт: ' + (currentProfile && currentProfile.phone ? currentProfile.phone : '—');
    await loadProfile();
  } catch (e) {
    statusEl.textContent = 'Помилка: ' + (e.message || e);
  } finally {
    updateBtn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', loadProfile);
