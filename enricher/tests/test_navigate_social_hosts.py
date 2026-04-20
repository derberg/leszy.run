from enricher.steps.navigate import SOCIAL_HOSTS, is_social_host


def test_facebook_is_social():
    assert is_social_host("https://www.facebook.com/events/12345") is True


def test_instagram_is_social():
    assert is_social_host("https://instagram.com/biegleszka") is True


def test_fb_short_domain_is_social():
    assert is_social_host("https://fb.com/page") is True


def test_normal_website_is_not_social():
    assert is_social_host("https://biegleszka.pl") is False


def test_none_and_empty_are_not_social():
    assert is_social_host(None) is False
    assert is_social_host("") is False


def test_social_hosts_set_is_populated():
    assert "facebook.com" in SOCIAL_HOSTS
    assert "instagram.com" in SOCIAL_HOSTS
