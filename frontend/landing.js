// Landing Page JavaScript - Carousel functionality

document.addEventListener('DOMContentLoaded', () => {
    initCarousel();
});

function initCarousel() {
    const slides = document.querySelectorAll('.carousel-slide');
    const indicators = document.querySelectorAll('.carousel-indicator');
    let currentSlide = 0;
    let carouselInterval;

    // Function to show a specific slide
    function showSlide(index) {
        // Remove active class from all slides and indicators
        slides.forEach(slide => slide.classList.remove('active'));
        indicators.forEach(indicator => indicator.classList.remove('active'));

        // Add active class to current slide and indicator
        if (slides[index]) {
            slides[index].classList.add('active');
        }
        if (indicators[index]) {
            indicators[index].classList.add('active');
        }

        currentSlide = index;
    }

    // Function to go to next slide
    function nextSlide() {
        const next = (currentSlide + 1) % slides.length;
        showSlide(next);
    }

    // Add click event listeners to indicators
    indicators.forEach((indicator, index) => {
        indicator.addEventListener('click', () => {
            showSlide(index);
            resetCarouselInterval();
        });
    });

    // Function to start auto-advancing carousel
    function startCarouselInterval() {
        carouselInterval = setInterval(nextSlide, 5000); // Change slide every 5 seconds
    }

    // Function to reset the carousel interval
    function resetCarouselInterval() {
        clearInterval(carouselInterval);
        startCarouselInterval();
    }

    // Start the carousel
    startCarouselInterval();

    // Pause carousel on hover
    const carouselContainer = document.querySelector('.carousel-container');
    if (carouselContainer) {
        carouselContainer.addEventListener('mouseenter', () => {
            clearInterval(carouselInterval);
        });

        carouselContainer.addEventListener('mouseleave', () => {
            startCarouselInterval();
        });
    }
}

